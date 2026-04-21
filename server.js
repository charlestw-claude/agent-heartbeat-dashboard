const express = require('express');
const cors = require('cors');
const path = require('path');
const { spawn } = require('child_process');
const { initDb, getDb } = require('./db/database');

const app = express();
const PORT = process.env.PORT || 3900;

const HEALTH_CHECK_SCRIPT = 'C:\\ClaudeProjects\\system-deployment\\profiles\\vm-agent\\config\\agents\\health-check.ps1';
const CHECK_NOW_COOLDOWN_MS = 15_000;
const CHECK_NOW_TIMEOUT_MS = 60_000;
let lastCheckNowAt = 0;
let checkNowInFlight = false;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize database
initDb();

// ─── API Routes ─────────────────────────────────────────────

// POST /api/heartbeat — health check writes heartbeat data
app.post('/api/heartbeat', (req, res) => {
  const { agents, source } = req.body;
  // agents: [{ name, status, pid?, telegram_mcp? }]
  //   telegram_mcp: 'ok' | 'fail' | omitted (treated as NULL = unknown/legacy)
  if (!Array.isArray(agents)) {
    return res.status(400).json({ error: 'agents must be an array' });
  }

  const src = source === 'manual' ? 'manual' : 'scheduled';

  const db = getDb();

  const getPrevMcp = db.prepare(
    `SELECT telegram_mcp FROM heartbeats
       WHERE agent_name = ? AND telegram_mcp IS NOT NULL
       ORDER BY timestamp DESC LIMIT 1`
  );
  const insertHeartbeat = db.prepare(
    'INSERT INTO heartbeats (agent_name, status, pid, source, telegram_mcp) VALUES (?, ?, ?, ?, ?)'
  );
  const insertEvent = db.prepare(
    'INSERT INTO events (agent_name, event_type, details) VALUES (?, ?, ?)'
  );

  const transitions = [];
  const persist = db.transaction((items) => {
    for (const agent of items) {
      const mcp = agent.telegram_mcp === 'ok' || agent.telegram_mcp === 'fail'
        ? agent.telegram_mcp
        : null;
      if (mcp) {
        const prev = getPrevMcp.get(agent.name);
        if (prev && prev.telegram_mcp !== mcp) {
          transitions.push({ name: agent.name, from: prev.telegram_mcp, to: mcp });
        }
      }
      insertHeartbeat.run(agent.name, agent.status, agent.pid || null, src, mcp);
    }
    for (const t of transitions) {
      const evt = t.to === 'fail' ? 'telegram_mcp_fail' : 'telegram_mcp_recover';
      insertEvent.run(t.name, evt, `${t.from} -> ${t.to}`);
    }
  });

  persist(agents);
  res.json({ ok: true, count: agents.length, source: src, transitions: transitions.length });
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
//   status is downgraded to 'offline' if telegram_mcp='fail' (process alive but bot dead).
//   raw_status preserves the process-level status for debugging.
app.get('/api/status', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT h.agent_name, h.status AS raw_status, h.pid, h.telegram_mcp, h.timestamp
    FROM heartbeats h
    INNER JOIN (
      SELECT agent_name, MAX(timestamp) as max_ts
      FROM heartbeats
      GROUP BY agent_name
    ) latest ON h.agent_name = latest.agent_name AND h.timestamp = latest.max_ts
    ORDER BY h.agent_name
  `).all();

  const enriched = rows.map(r => ({
    agent_name: r.agent_name,
    status: (r.raw_status === 'online' && r.telegram_mcp !== 'fail') ? 'online' : 'offline',
    raw_status: r.raw_status,
    telegram_mcp: r.telegram_mcp,
    pid: r.pid,
    timestamp: r.timestamp,
  }));

  res.json(enriched);
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
// Availability = process online AND (telegram_mcp IS NULL OR telegram_mcp = 'ok').
// NULL counts as ok so legacy rows (pre-MCP-probe) aren't retroactively marked down.
app.get('/api/uptime', (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      agent_name,
      COUNT(*) as total_checks,
      SUM(CASE WHEN status = 'online' AND (telegram_mcp IS NULL OR telegram_mcp = 'ok') THEN 1 ELSE 0 END) as online_checks,
      ROUND(
        CAST(SUM(CASE WHEN status = 'online' AND (telegram_mcp IS NULL OR telegram_mcp = 'ok') THEN 1 ELSE 0 END) AS REAL)
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
        CAST(SUM(CASE WHEN status = 'online' AND (telegram_mcp IS NULL OR telegram_mcp = 'ok') THEN 1 ELSE 0 END) AS REAL)
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
      SUM(CASE WHEN status = 'online' AND (telegram_mcp IS NULL OR telegram_mcp = 'ok') THEN 1 ELSE 0 END) as online_checks,
      ROUND(
        CAST(SUM(CASE WHEN status = 'online' AND (telegram_mcp IS NULL OR telegram_mcp = 'ok') THEN 1 ELSE 0 END) AS REAL)
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

// Fallback: serve index.html for SPA
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Agent Heartbeat Dashboard running on http://0.0.0.0:${PORT}`);
});
