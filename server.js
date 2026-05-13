const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { initDb, getDb } = require('./db/database');
const { initMetricsSchema } = require('./db/metrics-schema');
const collector = require('./metrics/collector');
const rollup = require('./metrics/rollup');
const archive = require('./metrics/archive');
const diskCaches = require('./metrics/disk-caches');
const claudeUsage = require('./metrics/claude-usage');
const agentModels = require('./metrics/agent-models');
const wsHub = require('./metrics/ws');

const app = express();
const PORT = process.env.PORT || 3900;

const HEALTH_CHECK_SCRIPT = 'C:\\ClaudeProjects\\system-deployment\\profiles\\vm-agent\\config\\agents\\health-check.ps1';
const CHECK_NOW_COOLDOWN_MS = 15_000;
const CHECK_NOW_TIMEOUT_MS = 60_000;
let lastCheckNowAt = 0;
let checkNowInFlight = false;

// Agent name -> channel state dir (mirrors health-check.ps1's $agentChannelDirMap).
// The .bat files set TELEGRAM_STATE_DIR to %USERPROFILE%\.claude\channels\<value>,
// which is where last_session.txt and fresh-start.flag live.
const CHANNELS_ROOT = path.join(os.homedir(), '.claude', 'channels');
const AGENT_CHANNEL_DIRS = {
  'Claude-Agent-01': 'telegram-agent-01',
  'Claude-Agent-02': 'telegram-agent-02',
  'Claude-Agent-03': 'telegram-agent-03',
  'Claude-Agent-04': 'telegram-agent-04',
  'Claude-Agent-05': 'telegram-agent-05',
  'Claude-Deloitte': 'telegram-deloitte',
  'Claude-Quant': 'telegram-quant',
  'Claude-Quant-2': 'telegram-quant-2',
  'Guest-Agent': 'telegram-guest-agent',
};

function getAgentStateDir(name) {
  const dir = AGENT_CHANNEL_DIRS[name];
  return dir ? path.join(CHANNELS_ROOT, dir) : null;
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize database
initDb();
initMetricsSchema();

// ─── API Routes ─────────────────────────────────────────────

// POST /api/heartbeat — health check writes heartbeat data
app.post('/api/heartbeat', (req, res) => {
  const { agents, source } = req.body;
  // agents: [{ name, status, pid? }]
  if (!Array.isArray(agents)) {
    return res.status(400).json({ error: 'agents must be an array' });
  }

  const src = source === 'manual' ? 'manual' : 'scheduled';

  const db = getDb();
  const stmt = db.prepare(
    'INSERT INTO heartbeats (agent_name, status, pid, source) VALUES (?, ?, ?, ?)'
  );

  const insertMany = db.transaction((items) => {
    for (const agent of items) {
      stmt.run(agent.name, agent.status, agent.pid || null, src);
    }
  });

  insertMany(agents);

  // Push to WS clients so status cards ("Last seen", status pill) update
  // without waiting for the next 60s page refresh. Fire-and-forget — a dead
  // send must not block the HTTP response.
  try {
    wsHub.send({
      type: 'heartbeats',
      data: {
        ts: new Date().toISOString(),
        source: src,
        agents: agents.map((a) => ({
          name: a.name,
          status: a.status,
          pid: a.pid || null,
        })),
      },
    });
  } catch (e) {
    console.error('WS heartbeat broadcast failed:', e.message);
  }

  res.json({ ok: true, count: agents.length, source: src });
});

// POST /api/event — log an event (offline, restart, etc.)
app.post('/api/event', (req, res) => {
  const { agent_name, event_type, details } = req.body;
  if (!agent_name || !event_type) {
    return res.status(400).json({ error: 'agent_name and event_type required' });
  }

  const db = getDb();
  db.prepare(
    'INSERT INTO events (agent_name, event_type, details) VALUES (?, ?, ?)'
  ).run(agent_name, event_type, details || null);

  res.json({ ok: true });
});

// GET /api/status — current status of all agents (latest heartbeat each)
app.get('/api/status', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT h.agent_name, h.status, h.pid, h.timestamp
    FROM heartbeats h
    INNER JOIN (
      SELECT agent_name, MAX(timestamp) as max_ts
      FROM heartbeats
      GROUP BY agent_name
    ) latest ON h.agent_name = latest.agent_name AND h.timestamp = latest.max_ts
    ORDER BY h.agent_name
  `).all();

  res.json(rows);
});

// GET /api/heartbeats?hours=24&agent=Claude-Agent-01
app.get('/api/heartbeats', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const agent = req.query.agent;
  const db = getDb();

  let query = `
    SELECT agent_name, status, pid, timestamp
    FROM heartbeats
    WHERE timestamp >= datetime('now', '-${hours} hours')
  `;
  const params = [];

  if (agent) {
    query += ' AND agent_name = ?';
    params.push(agent);
  }

  query += ' ORDER BY timestamp DESC';

  const rows = db.prepare(query).all(...params);
  res.json(rows);
});

// GET /api/uptime?days=7
app.get('/api/uptime', (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      agent_name,
      COUNT(*) as total_checks,
      SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) as online_checks,
      ROUND(
        CAST(SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) AS REAL)
        / COUNT(*) * 100, 2
      ) as uptime_pct
    FROM heartbeats
    WHERE timestamp >= datetime('now', '-${days} days')
      AND source = 'scheduled'
    GROUP BY agent_name
    ORDER BY agent_name
  `).all();

  res.json(rows);
});

// GET /api/heatmap?days=30 — hourly status for heatmap visualization
app.get('/api/heatmap', (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      agent_name,
      strftime('%Y-%m-%d', timestamp) as date,
      CAST(strftime('%H', timestamp) AS INTEGER) as hour,
      ROUND(
        CAST(SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) AS REAL)
        / COUNT(*) * 100, 1
      ) as uptime_pct
    FROM heartbeats
    WHERE timestamp >= datetime('now', '-${days} days')
      AND source = 'scheduled'
    GROUP BY agent_name, date, hour
    ORDER BY agent_name, date, hour
  `).all();

  res.json(rows);
});

// GET /api/restart-loops?windowMinutes=30&threshold=3
// Detect agents that are restart-looping. Counts `restart_attempt` events
// per agent within the sliding window; any agent at or above the threshold
// is flagged. The dashboard surfaces these in a red banner so operators see
// pathological behaviour (today's Agent-01 incident: ~20 restarts over 2hr)
// without having to scan the events log.
app.get('/api/restart-loops', (req, res) => {
  const windowMinutes = Math.max(parseInt(req.query.windowMinutes) || 30, 1);
  const threshold = Math.max(parseInt(req.query.threshold) || 3, 2);
  const db = getDb();

  const rows = db.prepare(`
    SELECT agent_name,
           COUNT(*) as count,
           MIN(timestamp) as since,
           MAX(timestamp) as until
    FROM events
    WHERE event_type = 'restart_attempt'
      AND timestamp >= datetime('now', '-${windowMinutes} minutes')
    GROUP BY agent_name
    HAVING count >= ?
    ORDER BY count DESC
  `).all(threshold);

  res.json({ loops: rows, threshold, windowMinutes });
});

// GET /api/events?hours=48
app.get('/api/events', (req, res) => {
  const hours = parseInt(req.query.hours) || 48;
  const db = getDb();

  const rows = db.prepare(`
    SELECT agent_name, event_type, details, timestamp
    FROM events
    WHERE timestamp >= datetime('now', '-${hours} hours')
    ORDER BY timestamp DESC
    LIMIT 200
  `).all();

  res.json(rows);
});

// GET /api/daily-summary?days=30 — daily uptime per agent
app.get('/api/daily-summary', (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      agent_name,
      strftime('%Y-%m-%d', timestamp) as date,
      COUNT(*) as total_checks,
      SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) as online_checks,
      ROUND(
        CAST(SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) AS REAL)
        / COUNT(*) * 100, 1
      ) as uptime_pct
    FROM heartbeats
    WHERE timestamp >= datetime('now', '-${days} days')
      AND source = 'scheduled'
    GROUP BY agent_name, date
    ORDER BY date, agent_name
  `).all();

  res.json(rows);
});

// POST /api/check-now — trigger health-check.ps1 immediately
app.post('/api/check-now', (req, res) => {
  const now = Date.now();
  if (checkNowInFlight) {
    return res.status(429).json({ error: 'check already in flight' });
  }
  if (now - lastCheckNowAt < CHECK_NOW_COOLDOWN_MS) {
    const retryInMs = CHECK_NOW_COOLDOWN_MS - (now - lastCheckNowAt);
    return res.status(429).json({ error: 'cooldown', retry_in_ms: retryInMs });
  }

  checkNowInFlight = true;
  lastCheckNowAt = now;

  const child = spawn(
    'powershell.exe',
    ['-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', HEALTH_CHECK_SCRIPT, '-Source', 'manual'],
    { windowsHide: true }
  );

  const timeout = setTimeout(() => {
    try { child.kill(); } catch {}
  }, CHECK_NOW_TIMEOUT_MS);

  child.on('exit', (code) => {
    clearTimeout(timeout);
    checkNowInFlight = false;
    if (!res.headersSent) {
      res.json({ ok: code === 0, exit_code: code });
    }
  });

  child.on('error', (err) => {
    clearTimeout(timeout);
    checkNowInFlight = false;
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  });
});

// ─── VM metrics ─────────────────────────────────────────────

// GET /api/metrics/recent?minutes=15 — raw 1s samples for the live chart
app.get('/api/metrics/recent', (req, res) => {
  const minutes = Math.min(parseInt(req.query.minutes) || 15, 120);
  const from = Math.floor(Date.now() / 1000) - (minutes * 60);
  const rows = getDb().prepare(`
    SELECT ts, cpu_pct, mem_used_gb, mem_total_gb,
           net_rx_bps, net_tx_bps, disk_read_bps, disk_write_bps,
           disk_free_gb, disk_total_gb, pagefile_used_gb, pagefile_total_gb,
           uptime_s, agents_mem_mb
    FROM vm_metrics_raw
    WHERE ts >= ?
    ORDER BY ts
  `).all(from);
  res.json(rows);
});

// GET /api/metrics/agents — current per-process RSS for bun.exe / claude.exe
app.get('/api/metrics/agents', (req, res) => {
  res.json(collector.getAgentsBreakdown());
});

// GET /api/agents/models — current model each agent's latest session is using
app.get('/api/agents/models', (req, res) => {
  const rows = getDb()
    .prepare('SELECT DISTINCT agent_name FROM heartbeats')
    .all();
  res.json(agentModels.getAgentModels(rows.map((r) => r.agent_name)));
});

// GET /api/disk/caches — npm/pip/puppeteer cache sizes (10-min TTL; ?refresh=1 forces rescan)
app.get('/api/disk/caches', (req, res) => {
  const force = req.query.refresh === '1';
  res.json(diskCaches.getInfo({ force }));
});

// GET /api/claude/usage — latest snapshot polled from ClaudeMonitor's local API.
app.get('/api/claude/usage', (req, res) => {
  res.json(claudeUsage.getSnapshot());
});

// GET /api/claude/analysis — peak-analysis matrix (24h avg + 7×24 DoW).
app.get('/api/claude/analysis', (req, res) => {
  res.json(claudeUsage.getAnalysis());
});

// GET /api/claude/stats — rolling-window summary stats from ClaudeMonitor v2.5.0.
app.get('/api/claude/stats', (req, res) => {
  res.json(claudeUsage.getStats());
});

// GET /api/metrics/1min?hours=24
app.get('/api/metrics/1min', (req, res) => {
  const hours = Math.min(parseInt(req.query.hours) || 24, 24 * 30);
  const from = Math.floor(Date.now() / 1000) - (hours * 3600);
  const rows = getDb().prepare(`
    SELECT ts, cpu_pct_avg, cpu_pct_max, mem_used_gb_avg, mem_used_gb_max,
           net_rx_bps_avg, net_tx_bps_avg, disk_read_bps_avg, disk_write_bps_avg
    FROM vm_metrics_1min
    WHERE ts >= ?
    ORDER BY ts
  `).all(from);
  res.json(rows);
});

// GET /api/metrics/hourly?days=90
app.get('/api/metrics/hourly', (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 3650);
  const from = Math.floor(Date.now() / 1000) - (days * 86400);
  const rows = getDb().prepare(`
    SELECT ts, cpu_pct_avg, cpu_pct_max, mem_used_gb_avg, mem_used_gb_max,
           net_rx_bps_avg, net_tx_bps_avg, disk_read_bps_avg, disk_write_bps_avg
    FROM vm_metrics_hourly
    WHERE ts >= ?
    ORDER BY ts
  `).all(from);
  res.json(rows);
});

// ─── Per-agent session control ──────────────────────────────
// Reads/writes files under %USERPROFILE%\.claude\channels\<dir>\:
//   - fresh-start.flag  : if present, the agent's .bat does a clean start
//                         and consumes the flag (one-shot)
//   - last_session.txt  : the last Claude Code session_id; the .bat passes
//                         this to `claude --resume` on restart

// GET /api/agent/:name/session-state — current flag + last session id
app.get('/api/agent/:name/session-state', (req, res) => {
  const stateDir = getAgentStateDir(req.params.name);
  if (!stateDir) return res.status(404).json({ error: 'unknown agent' });

  const flagPath = path.join(stateDir, 'fresh-start.flag');
  const sessionPath = path.join(stateDir, 'last_session.txt');

  const fresh_start = fs.existsSync(flagPath);
  let last_session = null;
  try {
    if (fs.existsSync(sessionPath)) {
      last_session = fs.readFileSync(sessionPath, 'utf8').trim() || null;
    }
  } catch {}

  res.json({ agent: req.params.name, fresh_start, last_session });
});

// POST /api/agent/:name/fresh-start — set the one-shot flag
app.post('/api/agent/:name/fresh-start', (req, res) => {
  const stateDir = getAgentStateDir(req.params.name);
  if (!stateDir) return res.status(404).json({ error: 'unknown agent' });

  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'fresh-start.flag'), new Date().toISOString());
    res.json({ ok: true, agent: req.params.name, fresh_start: true });
  } catch (e) {
    console.error(`fresh-start set failed for ${req.params.name}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/agent/:name/fresh-start — clear the flag
app.delete('/api/agent/:name/fresh-start', (req, res) => {
  const stateDir = getAgentStateDir(req.params.name);
  if (!stateDir) return res.status(404).json({ error: 'unknown agent' });

  try {
    const flagPath = path.join(stateDir, 'fresh-start.flag');
    if (fs.existsSync(flagPath)) fs.unlinkSync(flagPath);
    res.json({ ok: true, agent: req.params.name, fresh_start: false });
  } catch (e) {
    console.error(`fresh-start clear failed for ${req.params.name}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Centralised TG message log ─────────────────────────────────
// Cross-agent visibility for Manager-agent dispatch + audit. Agents POST every
// outbound TG action (reply / react / edit_message) via a PostToolUse hook;
// the central log is queryable by agent and time range.
// Schema: see db/database.js (tg_messages table).

// POST /api/tg-log — append one log entry
app.post('/api/tg-log', (req, res) => {
  const {
    agent_name, direction, tool,
    chat_id, message_id, reply_to,
    text_preview, session_id, raw_response,
  } = req.body || {};

  if (!agent_name || !direction) {
    return res.status(400).json({ error: 'agent_name and direction required' });
  }
  if (direction !== 'in' && direction !== 'out') {
    return res.status(400).json({ error: "direction must be 'in' or 'out'" });
  }

  try {
    const db = getDb();
    const info = db.prepare(`
      INSERT INTO tg_messages (
        agent_name, direction, tool, chat_id, message_id,
        reply_to, text_preview, session_id, raw_response
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      agent_name,
      direction,
      tool || null,
      chat_id ? String(chat_id) : null,
      message_id ? String(message_id) : null,
      reply_to ? String(reply_to) : null,
      text_preview || null,
      session_id || null,
      raw_response || null
    );
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    console.error(`tg-log write failed (agent=${agent_name} dir=${direction}):`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/tg-log?hours=24&agent=Claude-Agent-03&direction=out&limit=200
app.get('/api/tg-log', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
  const agent = req.query.agent;
  const direction = req.query.direction;

  let query = `
    SELECT id, agent_name, direction, tool, chat_id, message_id,
           reply_to, text_preview, session_id, raw_response, timestamp
    FROM tg_messages
    WHERE timestamp >= datetime('now', '-${hours} hours')
  `;
  const params = [];

  if (agent) {
    query += ' AND agent_name = ?';
    params.push(agent);
  }
  if (direction === 'in' || direction === 'out') {
    query += ' AND direction = ?';
    params.push(direction);
  }

  query += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(limit);

  const rows = getDb().prepare(query).all(...params);
  res.json(rows);
});

// Fallback: serve index.html for SPA
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = http.createServer(app);
wsHub.attach(server);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Agent Heartbeat Dashboard running on http://127.0.0.1:${PORT}`);
  collector.start();
  rollup.start();
  archive.start();
  claudeUsage.start();
});

process.on('SIGTERM', () => {
  collector.stop();
  rollup.stop();
  archive.stop();
  claudeUsage.stop();
  server.close(() => process.exit(0));
});
