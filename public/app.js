const API = '';
const REFRESH_INTERVAL = 60_000; // 1 minute

const AGENT_COLORS = {
  'Claude-Agent-01': '#3b82f6',
  'Claude-Agent-02': '#8b5cf6',
  'Claude-Agent-03': '#06b6d4',
  'Claude-Agent-04': '#f59e0b',
  'Claude-Agent-05': '#10b981',
  'Claude-Deloitte': '#ec4899',
  'Claude-Quant':    '#f97316',
  'Claude-Quant-2':  '#14b8a6',
};

// Status-card groups. Order here is render order; first matching group wins.
// Empty groups still render a placeholder so the user can see slots that are
// reserved for future agents (e.g. Agent Manager, Secretary).
const AGENT_GROUPS = [
  { key: 'manager',   label: 'Agent Manager', match: (n) => /manager/i.test(n) },
  { key: 'assistant', label: 'Assistant',     match: (n) => /secretary/i.test(n) },
  { key: 'agents',    label: 'Agents',        match: (n) => /^claude-agent-\d+$/i.test(n) },
  { key: 'quant',     label: 'Quant',         match: (n) => /^claude-quant/i.test(n) },
  { key: 'deloitte',  label: 'Deloitte',      match: (n) => /deloitte/i.test(n) },
  { key: 'guest',     label: 'Guest',         match: (n) => /guest/i.test(n) },
];

function getAgentGroupKey(name) {
  for (const g of AGENT_GROUPS) {
    if (g.match(name)) return g.key;
  }
  return 'agents';
}

// ─── Utility ────────────────────────────────────────────────

function formatTime(ts) {
  const d = new Date(ts + 'Z');
  return d.toLocaleString('zh-TW', { hour12: false });
}

function formatTimeShort(ts) {
  const d = new Date(ts + 'Z');
  return d.toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

function timeSince(ts) {
  const now = Date.now();
  const then = new Date(ts + 'Z').getTime();
  const diff = Math.floor((now - then) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function getAgentColor(name) {
  return AGENT_COLORS[name] || '#6b7280';
}

async function fetchJson(url) {
  const res = await fetch(API + url);
  return res.json();
}

// Health tier derived from 7-day uptime %. `statusClass` short-circuits when
// the agent is not currently online so we don't claim "stable" for a box
// that is actually down right now.
function healthTier(uptimePct, statusClass) {
  if (statusClass === 'offline') return { level: 'down', text: 'Down' };
  if (uptimePct == null) return null;
  const n = typeof uptimePct === 'string' ? parseFloat(uptimePct) : uptimePct;
  if (isNaN(n)) return null;
  if (n >= 99.5) return { level: 'stable',   text: 'Stable' };
  if (n >= 95)   return { level: 'flaky',    text: 'Flaky' };
  return { level: 'unstable', text: 'Unstable' };
}

// Activity tier combines two signals:
//   - `active`: true iff the agent has an ESTABLISHED outbound :443 TCP
//     connection. This is the authoritative "streaming from Anthropic API"
//     signal. CPU during inference is near zero (model runs server-side),
//     so CPU alone would miss this.
//   - `cpuPct`: summed across the agent's processes, catches local work
//     such as tool execution when no API call is in flight.
function activityTier(cpuPct, active) {
  // Thinking = active TLS socket AND visible CPU. The ESTABLISHED :443 socket
  // alone is not enough because HTTP/2 keep-alive keeps it open for minutes
  // after a conversation ends, which would produce sticky false positives.
  // Requiring a small amount of CPU ensures tokens are actually being
  // received and parsed.
  if (active === true && cpuPct != null && cpuPct >= 0.3) {
    return { level: 'thinking', text: 'Thinking' };
  }
  if (cpuPct == null || isNaN(cpuPct)) return null;
  if (cpuPct >= 1) return { level: 'working', text: 'Working' };
  return { level: 'idle', text: 'Idle' };
}

// Normalize "Claude-Agent-05" and "Agent-05" to the same key so the Status
// Card (Claude- prefixed) and metrics (sometimes without prefix, e.g.
// Guest-Agent) can be joined.
function normalizeAgentKey(name) {
  if (!name) return '';
  return name.replace(/^Claude-/i, '').toLowerCase();
}

// Combine current-activity and 7-day-health into a single signal pill.
// Activity wins when the agent is actually doing something; otherwise we
// fall back to the long-run health tier so the pill always says something
// meaningful.
function computeSignal(cpuPct, active, uptimePct, statusClass) {
  const act = activityTier(cpuPct, active);
  if (act && act.level !== 'idle') {
    return { level: act.level, text: act.text };
  }
  return healthTier(uptimePct, statusClass);
}

// Cache of latest per-agent signals ({cpu, active}) keyed by normalized name.
// The 60s card refresh keeps the DOM; the 5s poll just toggles class/text
// on .card-signal without re-rendering.
let lastAgentSignals = {};

const SIGNAL_CLASSES = ['thinking', 'working', 'idle', 'stable', 'flaky', 'unstable', 'down'];

function applySignalsToCards(byAgent) {
  const nodes = document.querySelectorAll('.card-signal[data-signal-for]');
  nodes.forEach((node) => {
    const key = node.getAttribute('data-signal-for');
    const uptimeRaw = node.getAttribute('data-uptime');
    const uptimePct = uptimeRaw === '' ? null : parseFloat(uptimeRaw);
    const statusClass = node.getAttribute('data-status-class') || 'unknown';
    const entry = byAgent[key] || {};
    const cpu = entry.cpu;
    const active = entry.active;
    const signal = computeSignal(cpu, active, uptimePct, statusClass);
    SIGNAL_CLASSES.forEach((c) => node.classList.remove(c));
    if (signal) {
      node.classList.add(signal.level);
      node.textContent = signal.text;
      const cpuStr = cpu == null ? '--' : cpu.toFixed(1) + '%';
      const activeStr = active === true ? 'yes' : (active === false ? 'no' : '--');
      const upStr = uptimePct == null ? '--' : uptimePct + '%';
      node.title = `API streaming: ${activeStr} · CPU: ${cpuStr} · 7d uptime: ${upStr}`;
    } else {
      node.textContent = '';
      node.title = '';
    }
  });
}

function applyAgentsBreakdown(data) {
  const agents = (data && Array.isArray(data.agents)) ? data.agents : [];
  const byAgent = {};
  for (const a of agents) {
    byAgent[normalizeAgentKey(a.agent)] = {
      cpu: a.total_cpu_pct,
      active: a.active === true,
    };
  }
  lastAgentSignals = byAgent;
  applySignalsToCards(byAgent);
}

// Exposed so the /ws/metrics handler in app-metrics.js can push updates
// directly when the server detects an active-socket change.
window.applyAgentsBreakdown = applyAgentsBreakdown;

// Heartbeat push — the server broadcasts every POST /api/heartbeat so the
// status card ("Last seen", status pill, card bg class) updates within
// milliseconds instead of waiting for the next 60s page refresh.
function applyHeartbeatsPush(data) {
  if (!data || !Array.isArray(data.agents)) return;
  const ts = data.ts || new Date().toISOString();
  let anyStatusChanged = false;
  for (const a of data.agents) {
    const key = normalizeAgentKey(a.name);
    const card = document.querySelector(`.status-card[data-agent-key="${key}"]`);
    if (!card) continue;

    if (card.className !== `status-card ${a.status}`) {
      card.className = `status-card ${a.status}`;
      anyStatusChanged = true;
    }
    const statusPill = card.querySelector('.card-status');
    if (statusPill) {
      statusPill.className = `card-status ${a.status}`;
      statusPill.textContent = a.status;
    }
    const lastSeenEl = card.querySelector('.card-lastseen');
    if (lastSeenEl) {
      lastSeenEl.setAttribute('data-ts', ts);
      lastSeenEl.textContent = `Last seen: ${timeSince(ts)}`;
    }
    const pidEl = card.querySelector('.card-pid');
    if (pidEl) pidEl.textContent = a.pid ? `PID: ${a.pid}` : '';

    const signal = card.querySelector('.card-signal');
    if (signal) signal.setAttribute('data-status-class', a.status);
  }
  if (anyStatusChanged) {
    applySignalsToCards(lastAgentSignals);
    const cards = document.querySelectorAll('.status-card');
    const onlineCount = Array.from(cards).filter((c) => c.classList.contains('online')).length;
    const header = document.getElementById('overallUptime');
    if (header && cards.length > 0) header.textContent = `${onlineCount}/${cards.length} Online`;
  }
}
window.applyHeartbeatsPush = applyHeartbeatsPush;

// Tick relative "Last seen" labels each second so the text doesn't freeze
// between heartbeat pushes.
setInterval(() => {
  document.querySelectorAll('.card-lastseen[data-ts]').forEach((el) => {
    const ts = el.getAttribute('data-ts');
    if (ts) el.textContent = `Last seen: ${timeSince(ts)}`;
  });
}, 1000);

async function pollAgentActivity() {
  try {
    const r = await fetch('/api/metrics/agents');
    if (!r.ok) return;
    const data = await r.json();
    applyAgentsBreakdown(data);
  } catch {}
}

// ─── Claude Subscription Usage ──────────────────────────────

// Human-readable countdown to an ISO timestamp, compact form (1d 3h / 42m).
function timeUntil(iso) {
  const target = new Date(iso).getTime();
  const diff = target - Date.now();
  if (!Number.isFinite(diff) || diff <= 0) return 'resetting…';
  const sec = Math.floor(diff / 1000);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${sec}s`;
}

function bucketLevel(pct) {
  if (pct >= 90) return 'danger';
  if (pct >= 75) return 'high';
  if (pct >= 40) return 'mid';
  return 'low';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Activity badge level → CSS class. Mirrors ClaudeMonitor's own tiers.
const ACTIVITY_LEVEL_CLASS = {
  Maxed: 'maxed',
  Peak: 'peak',
  Active: 'active',
  Normal: 'normal',
  Quiet: 'quiet',
  Hidden: 'hidden',
};

// Render a single percent-based usage bar.
function renderPctRow(label, usedPct, resetText, resetAt, suffix) {
  const pct = Math.min(100, Math.max(0, Number(usedPct) || 0));
  const level = bucketLevel(pct);
  const resetBits = [];
  if (resetAt) resetBits.push(`resets in ${timeUntil(resetAt)}`);
  else if (resetText) resetBits.push(escapeHtml(resetText));
  const reset = resetBits.length ? `<span class="usage-reset">${resetBits.join(' · ')}</span>` : '';
  const tail = suffix ? ` <span class="usage-raw">${escapeHtml(suffix)}</span>` : '';
  return `
    <div class="usage-row">
      <div class="usage-row-header">
        <span class="usage-label">${escapeHtml(label)}${tail}</span>
        <span class="usage-value">${pct}%</span>
      </div>
      <div class="usage-bar">
        <div class="usage-bar-fill level-${level}" style="width: ${pct}%"></div>
      </div>
      ${reset}
    </div>
  `;
}

function renderClaudeUsage(snapshot) {
  const panel = document.getElementById('claudeUsagePanel');
  const barsEl = document.getElementById('claudeUsageBars');
  const planEl = document.getElementById('claudeUsagePlan');
  const metaEl = document.getElementById('claudeUsageMeta');
  const activityEl = document.getElementById('claudeUsageActivity');
  if (!panel || !barsEl) return;

  // Nothing polled yet (or the snapshot aged past MAX_PAYLOAD_AGE_MS and was
  // cleared server-side). Keep the panel hidden so users without
  // ClaudeMonitor running don't see an empty widget.
  if (!snapshot || !snapshot.payload) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  const { payload, receivedAt, stale, lastError } = snapshot;

  planEl.textContent = payload.plan || '';
  const metaParts = [];
  if (receivedAt) metaParts.push(`Updated ${timeSince(receivedAt.replace(/Z$/, ''))}`);
  if (stale) metaParts.push(lastError ? `⚠ stale (${lastError})` : '⚠ stale');
  metaEl.textContent = metaParts.join(' · ');

  panel.classList.toggle('stale', !!stale);
  panel.classList.remove('errored');

  if (activityEl) {
    if (payload.activity && payload.activity.level && payload.activity.level !== 'Hidden') {
      const lvl = ACTIVITY_LEVEL_CLASS[payload.activity.level] || 'normal';
      activityEl.className = `usage-activity level-${lvl}`;
      activityEl.textContent = payload.activity.label || payload.activity.level;
      activityEl.hidden = false;
    } else {
      activityEl.hidden = true;
    }
  }

  if (payload.isLoggedIn === false) {
    barsEl.innerHTML = `<div class="usage-error">ClaudeMonitor 未登入 claude.ai — 請開啟 ClaudeMonitor 完成登入</div>`;
    panel.classList.add('errored');
    return;
  }

  const rows = [];

  if (payload.session) {
    rows.push(renderPctRow('Session (5h)', payload.session.usedPct, payload.session.resetText, payload.session.resetAt));
  }
  if (payload.weeklyAllModels) {
    rows.push(renderPctRow('7 Day · All', payload.weeklyAllModels.usedPct, payload.weeklyAllModels.resetText, payload.weeklyAllModels.resetAt));
  }
  if (payload.weeklySonnet) {
    rows.push(renderPctRow('7 Day · Sonnet', payload.weeklySonnet.usedPct, payload.weeklySonnet.resetText, payload.weeklySonnet.resetAt));
  }
  if (payload.weeklyOpus) {
    rows.push(renderPctRow('7 Day · Opus', payload.weeklyOpus.usedPct, payload.weeklyOpus.resetText, payload.weeklyOpus.resetAt));
  }
  if (payload.weeklyDesign) {
    rows.push(renderPctRow('Claude Design', payload.weeklyDesign.usedPct, payload.weeklyDesign.resetText, payload.weeklyDesign.resetAt));
  }
  if (payload.dailyRoutineRuns) {
    const r = payload.dailyRoutineRuns;
    const suffix = (r.used != null && r.total != null) ? `(${r.used} / ${r.total})` : '';
    rows.push(renderPctRow('Daily Routine', r.usedPct, r.resetText, r.resetAt, suffix));
  }
  if (payload.extraUsage && payload.extraUsage.enabled) {
    const e = payload.extraUsage;
    const suffix = e.spentText ? `(${e.spentText})` : '';
    rows.push(renderPctRow('Extra Usage', e.spentPct, e.resetText, e.resetAt, suffix));
  }

  if (rows.length === 0) {
    barsEl.innerHTML = `<div class="usage-empty">尚無 usage 資料</div>`;
    return;
  }

  barsEl.innerHTML = rows.join('');
}

async function pollClaudeUsage() {
  try {
    const r = await fetch('/api/claude/usage');
    if (!r.ok) return;
    const snap = await r.json();
    renderClaudeUsage(snap);
  } catch {}
}

// ─── Status Cards ───────────────────────────────────────────

async function renderStatusCards() {
  const [status, uptime] = await Promise.all([
    fetchJson('/api/status'),
    fetchJson('/api/uptime?days=7'),
  ]);

  const uptimeMap = {};
  uptime.forEach(u => uptimeMap[u.agent_name] = u);

  const container = document.getElementById('statusCards');

  if (status.length === 0) {
    container.innerHTML = '<div class="loading">No heartbeat data yet. Waiting for first health check...</div>';
    return;
  }

  const cardHtml = (agent) => {
    const ut = uptimeMap[agent.agent_name];
    const uptimePct = ut ? ut.uptime_pct : null;
    const uptimePctStr = uptimePct == null ? '--' : uptimePct;
    const statusClass = agent.status || 'unknown';
    const agentKey = normalizeAgentKey(agent.agent_name);

    return `
      <div class="status-card ${statusClass}" data-agent-key="${agentKey}">
        <div class="card-header">
          <span class="card-name">${agent.agent_name.replace('Claude-', '')}</span>
          <div class="card-badges">
            <span class="card-status ${statusClass}">${statusClass}</span>
            <span class="card-signal"
                  data-signal-for="${agentKey}"
                  data-uptime="${uptimePct == null ? '' : uptimePct}"
                  data-status-class="${statusClass}"></span>
          </div>
        </div>
        <div class="card-meta">
          <span>Uptime (7d): ${uptimePctStr}%</span>
          <span class="card-lastseen" data-ts="${agent.timestamp}">Last seen: ${timeSince(agent.timestamp)}</span>
          <span class="card-pid">${agent.pid ? `PID: ${agent.pid}` : ''}</span>
        </div>
      </div>
    `;
  };

  const byGroup = {};
  AGENT_GROUPS.forEach((g) => { byGroup[g.key] = []; });
  for (const agent of status) {
    const key = getAgentGroupKey(agent.agent_name);
    (byGroup[key] || byGroup.agents).push(agent);
  }
  for (const key of Object.keys(byGroup)) {
    byGroup[key].sort((a, b) => a.agent_name.localeCompare(b.agent_name));
  }

  container.innerHTML = AGENT_GROUPS.map((group) => {
    const members = byGroup[group.key] || [];
    const body = members.length
      ? members.map(cardHtml).join('')
      : '<div class="group-empty">— 尚未建立 —</div>';
    return `
      <section class="status-group" data-group="${group.key}">
        <h3 class="group-label">
          <span class="group-label-text">${group.label}</span>
          <span class="group-count">${members.length}</span>
        </h3>
        <div class="status-cards">${body}</div>
      </section>
    `;
  }).join('');

  // Paint the combined signal pills from whatever cached metrics we have;
  // the 5s poll keeps them fresh and promotes Working/Thinking when CPU
  // rises or an outbound :443 connection appears.
  applySignalsToCards(lastAgentSignals);

  // Update header
  const onlineCount = status.filter(a => a.status === 'online').length;
  const totalCount = status.length;
  document.getElementById('overallUptime').textContent =
    `${onlineCount}/${totalCount} Online`;
  document.getElementById('lastUpdate').textContent =
    `Updated: ${new Date().toLocaleTimeString('zh-TW', { hour12: false })}`;
}

// ─── Timeline Chart ─────────────────────────────────────────

let timelineChartInstance = null;

async function renderTimelineChart() {
  const data = await fetchJson('/api/heartbeats?hours=24');

  if (!timelineChartInstance) {
    timelineChartInstance = echarts.init(
      document.getElementById('timelineChart'), null, { renderer: 'canvas' }
    );
  }

  // Group by agent
  const agents = {};
  data.forEach(row => {
    if (!agents[row.agent_name]) agents[row.agent_name] = [];
    agents[row.agent_name].push(row);
  });

  const series = Object.keys(agents).sort().map(name => {
    const points = agents[name]
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .map(row => [
        new Date(row.timestamp + 'Z').getTime(),
        row.status === 'online' ? 1 : 0,
      ]);

    return {
      name: name.replace('Claude-', ''),
      type: 'line',
      step: 'end',
      symbol: 'none',
      lineStyle: { width: 2 },
      itemStyle: { color: getAgentColor(name) },
      data: points,
    };
  });

  const option = {
    backgroundColor: 'transparent',
    textStyle: { color: '#9ba0b5' },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#1a1d27',
      borderColor: '#2e3345',
      textStyle: { color: '#e4e6ed', fontSize: 12 },
      formatter: (params) => {
        const time = new Date(params[0].value[0]).toLocaleTimeString('zh-TW', { hour12: false });
        const lines = params.map(p =>
          `<span style="color:${p.color}">\u25CF</span> ${p.seriesName}: ${p.value[1] === 1 ? 'Online' : 'Offline'}`
        );
        return `${time}<br>${lines.join('<br>')}`;
      },
    },
    legend: {
      top: 0,
      textStyle: { color: '#9ba0b5', fontSize: 11 },
      itemWidth: 12,
      itemHeight: 8,
    },
    grid: { left: 40, right: 16, top: 36, bottom: 30 },
    xAxis: {
      type: 'time',
      axisLine: { lineStyle: { color: '#2e3345' } },
      axisLabel: {
        color: '#9ba0b5',
        fontSize: 11,
        formatter: (val) => {
          const d = new Date(val);
          return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        },
      },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      min: -0.1,
      max: 1.1,
      axisLabel: {
        color: '#9ba0b5',
        fontSize: 11,
        formatter: (v) => v === 1 ? 'ON' : v === 0 ? 'OFF' : '',
      },
      splitLine: { lineStyle: { color: '#2e334522' } },
    },
    series,
  };

  timelineChartInstance.setOption(option, true);
}

// ─── Uptime Bar Chart ───────────────────────────────────────

let uptimeChartInstance = null;

async function renderUptimeChart() {
  const data = await fetchJson('/api/uptime?days=7');

  if (!uptimeChartInstance) {
    uptimeChartInstance = echarts.init(
      document.getElementById('uptimeChart'), null, { renderer: 'canvas' }
    );
  }

  const names = data.map(d => d.agent_name.replace('Claude-', ''));
  const values = data.map(d => d.uptime_pct);
  const colors = data.map(d => {
    if (d.uptime_pct >= 99) return '#22c55e';
    if (d.uptime_pct >= 95) return '#eab308';
    return '#ef4444';
  });

  const option = {
    backgroundColor: 'transparent',
    textStyle: { color: '#9ba0b5' },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#1a1d27',
      borderColor: '#2e3345',
      textStyle: { color: '#e4e6ed', fontSize: 12 },
      formatter: (params) => `${params[0].name}: ${params[0].value}%`,
    },
    grid: { left: 90, right: 30, top: 8, bottom: 8 },
    xAxis: {
      type: 'value',
      min: 0,
      max: 100,
      axisLabel: { color: '#9ba0b5', fontSize: 11, formatter: '{value}%' },
      splitLine: { lineStyle: { color: '#2e334522' } },
    },
    yAxis: {
      type: 'category',
      data: names,
      axisLabel: { color: '#9ba0b5', fontSize: 11 },
      axisLine: { lineStyle: { color: '#2e3345' } },
    },
    series: [{
      type: 'bar',
      data: values.map((v, i) => ({ value: v, itemStyle: { color: colors[i] } })),
      barWidth: 14,
      backgroundStyle: { color: '#232733' },
      showBackground: true,
      label: {
        show: true,
        position: 'right',
        color: '#9ba0b5',
        fontSize: 11,
        formatter: '{c}%',
      },
    }],
  };

  uptimeChartInstance.setOption(option, true);
}

// ─── Heatmap Chart ──────────────────────────────────────────

let heatmapChartInstance = null;

async function renderHeatmapChart() {
  const data = await fetchJson('/api/heatmap?days=30');

  if (!heatmapChartInstance) {
    heatmapChartInstance = echarts.init(
      document.getElementById('heatmapChart'), null, { renderer: 'canvas' }
    );
  }

  // Get unique dates and agents
  const dates = [...new Set(data.map(d => d.date))].sort();
  const agents = [...new Set(data.map(d => d.agent_name))].sort();
  const agentLabels = agents.map(a => a.replace('Claude-', ''));

  // Build heatmap data: [dateIndex, agentIndex, value]
  const heatmapData = data.map(d => {
    const dateIdx = dates.indexOf(d.date);
    const agentIdx = agents.indexOf(d.agent_name);
    return [dateIdx, agentIdx, d.uptime_pct];
  });

  // Aggregate by day (average across hours)
  const dailyMap = {};
  data.forEach(d => {
    const key = `${d.date}|${d.agent_name}`;
    if (!dailyMap[key]) dailyMap[key] = { sum: 0, count: 0 };
    dailyMap[key].sum += d.uptime_pct;
    dailyMap[key].count += 1;
  });

  const dailyData = [];
  const uniqueDates = [...new Set(data.map(d => d.date))].sort();
  uniqueDates.forEach((date, di) => {
    agents.forEach((agent, ai) => {
      const key = `${date}|${agent}`;
      const entry = dailyMap[key];
      dailyData.push([di, ai, entry ? Math.round(entry.sum / entry.count) : null]);
    });
  });

  const option = {
    backgroundColor: 'transparent',
    textStyle: { color: '#9ba0b5' },
    tooltip: {
      backgroundColor: '#1a1d27',
      borderColor: '#2e3345',
      textStyle: { color: '#e4e6ed', fontSize: 12 },
      formatter: (params) => {
        const date = uniqueDates[params.value[0]];
        const agent = agentLabels[params.value[1]];
        const val = params.value[2];
        return `${date}<br>${agent}: ${val != null ? val + '%' : 'No data'}`;
      },
    },
    grid: {
      left: window.innerWidth <= 480 ? 70 : 100,
      right: window.innerWidth <= 480 ? 16 : 40,
      top: 8,
      bottom: 60,
    },
    xAxis: {
      type: 'category',
      data: uniqueDates.map(d => d.slice(5)), // MM-DD
      axisLabel: {
        color: '#9ba0b5',
        fontSize: window.innerWidth <= 480 ? 9 : 10,
        rotate: window.innerWidth <= 768 ? 0 : 45,
        hideOverlap: true,
        interval: window.innerWidth <= 480 ? 'auto' : (window.innerWidth <= 768 ? 3 : 0),
      },
      splitArea: { show: false },
    },
    yAxis: {
      type: 'category',
      data: agentLabels,
      axisLabel: {
        color: '#9ba0b5',
        fontSize: window.innerWidth <= 480 ? 10 : 11,
      },
    },
    visualMap: {
      min: 0,
      max: 100,
      calculable: false,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      itemWidth: 12,
      itemHeight: 120,
      textStyle: { color: '#9ba0b5', fontSize: 11 },
      inRange: {
        color: ['#7f1d1d', '#991b1b', '#dc2626', '#f59e0b', '#22c55e', '#16a34a'],
      },
      formatter: (val) => Math.round(val) + '%',
    },
    series: [{
      type: 'heatmap',
      data: dailyData.filter(d => d[2] != null),
      itemStyle: {
        borderColor: '#1a1d27',
        borderWidth: 2,
        borderRadius: 3,
      },
      emphasis: {
        itemStyle: { borderColor: '#fff', borderWidth: 2 },
      },
    }],
  };

  heatmapChartInstance.setOption(option, true);
}

// ─── Events Table ───────────────────────────────────────────

async function renderEvents() {
  const events = await fetchJson('/api/events?hours=48');
  const tbody = document.querySelector('#eventsTable tbody');

  if (events.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-dim)">No events in the last 48 hours</td></tr>';
    return;
  }

  tbody.innerHTML = events.map(e => `
    <tr>
      <td>${formatTime(e.timestamp)}</td>
      <td>${e.agent_name.replace('Claude-', '')}</td>
      <td><span class="event-badge ${e.event_type}">${e.event_type.replace('_', ' ')}</span></td>
      <td>${e.details || '-'}</td>
    </tr>
  `).join('');
}

// ─── Resize Handler ─────────────────────────────────────────

window.addEventListener('resize', () => {
  timelineChartInstance?.resize();
  uptimeChartInstance?.resize();
  heatmapChartInstance?.resize();
});

// ─── Init & Refresh ─────────────────────────────────────────

async function refresh({ triggerCheck = false } = {}) {
  const btn = document.getElementById('refreshBtn');
  btn?.classList.add('spinning');
  if (btn) btn.disabled = true;

  try {
    if (triggerCheck) {
      try {
        const res = await fetch(API + '/api/check-now', { method: 'POST' });
        if (res.ok) {
          await new Promise(r => setTimeout(r, 500));
        } else if (res.status === 429) {
          console.info('check-now: cooldown or already running, skipping');
        }
      } catch (err) {
        console.warn('check-now failed, falling back to DB refresh:', err);
      }
    }

    await Promise.all([
      renderStatusCards(),
      renderTimelineChart(),
      renderUptimeChart(),
      renderHeatmapChart(),
      renderEvents(),
    ]);
  } catch (err) {
    console.error('Refresh error:', err);
  } finally {
    btn?.classList.remove('spinning');
    if (btn) btn.disabled = false;
  }
}

document.getElementById('refreshBtn')?.addEventListener('click', () => refresh({ triggerCheck: true }));

refresh();
setInterval(() => refresh(), REFRESH_INTERVAL);

// Primary delivery of agent activity is a WS push from /ws/metrics — the
// server broadcasts an `agents` message every time refreshAgentProcesses or
// refreshActiveSockets updates the cached breakdown (~2s worst case).
// We still prime once here and keep a slow polling fallback for robustness
// in case the WS is temporarily disconnected.
pollAgentActivity();
setInterval(pollAgentActivity, 30000);

// Claude subscription usage — server probes every 5 min, so a 60s client
// poll is plenty (ties the "Updated Ns ago" meta to roughly a minute of
// freshness without flooding the endpoint).
pollClaudeUsage();
setInterval(pollClaudeUsage, 60_000);
