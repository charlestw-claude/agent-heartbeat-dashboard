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

  container.innerHTML = status.map(agent => {
    const ut = uptimeMap[agent.agent_name];
    const uptimePct = ut ? ut.uptime_pct : null;
    const uptimePctStr = uptimePct == null ? '--' : uptimePct;
    const statusClass = agent.status || 'unknown';
    const health = healthTier(uptimePct, statusClass);

    return `
      <div class="status-card ${statusClass}">
        <div class="card-header">
          <span class="card-name">${agent.agent_name.replace('Claude-', '')}</span>
          <div class="card-badges">
            <span class="card-status ${statusClass}">${statusClass}</span>
            ${health ? `<span class="card-health ${health.level}">${health.text}</span>` : ''}
          </div>
        </div>
        <div class="card-meta">
          <span>Uptime (7d): ${uptimePctStr}%</span>
          <span>Last seen: ${timeSince(agent.timestamp)}</span>
          ${agent.pid ? `<span>PID: ${agent.pid}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');

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
