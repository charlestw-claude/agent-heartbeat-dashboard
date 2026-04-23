// VM realtime metrics panel. Streams 1s samples over WebSocket and renders
// multiple split line charts: CPU+RAM and Net RX+TX. A shared 30fps tick
// drifts each chart's xAxis against wall-clock time for smooth left-scroll.
// Gauges (top row) show the latest sample values.

(function () {
  const WINDOW_MS = 2 * 60 * 1000;
  const BUFFER_POINTS = 150;
  const statusEl = document.getElementById('vmMetricsStatus');
  const cpuEl = document.getElementById('vmCpu');
  const memEl = document.getElementById('vmMem');
  const netEl = document.getElementById('vmNet');
  const diskFreeEl = document.getElementById('vmDiskFree');
  const pagefileEl = document.getElementById('vmPagefile');
  const agentsEl = document.getElementById('vmAgents');
  const uptimeEl = document.getElementById('vmUptime');
  const agentsTbody = document.getElementById('vmAgentsTbody');
  const agentsCountEl = document.getElementById('vmAgentsCount');
  const agentsDetailEl = document.querySelector('.vm-agents-detail:not(.vm-caches-detail)');
  const cachesDetailEl = document.querySelector('.vm-caches-detail');
  const cachesTbody = document.getElementById('vmCachesTbody');
  const cachesTotalEl = document.getElementById('vmCachesTotal');
  const cachesRefreshBtn = document.getElementById('vmCachesRefresh');
  const diskGauge = diskFreeEl ? diskFreeEl.closest('.vm-gauge') : null;
  const pagefileGauge = pagefileEl ? pagefileEl.closest('.vm-gauge') : null;
  const cpuBadgeEl = document.getElementById('vmCpuBadge');
  const memBadgeEl = document.getElementById('vmMemBadge');
  const netBadgeEl = document.getElementById('vmNetBadge');
  const topAgentBadgeEl = document.getElementById('vmTopAgentBadge');

  function isNarrow() { return window.innerWidth <= 640; }

  function fmtBytes(bps) {
    if (bps === null || bps === undefined) return '--';
    const mb = bps / 1048576;
    if (mb >= 1) return mb.toFixed(1) + ' MB/s';
    const kb = bps / 1024;
    if (kb >= 1) return kb.toFixed(0) + ' KB/s';
    return Math.round(bps) + ' B/s';
  }

  function fmtUptime(sec) {
    if (sec === null || sec === undefined) return '--';
    const s = Math.max(0, Math.floor(sec));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  function fmtMem(mb) {
    if (mb === null || mb === undefined) return '--';
    if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
    return mb.toFixed(0) + ' MB';
  }

  function fmtSize(bytes) {
    if (bytes == null) return '--';
    const gb = bytes / (1024 ** 3);
    if (gb >= 1) return gb.toFixed(2) + ' GB';
    const mb = bytes / (1024 ** 2);
    if (mb >= 1) return mb.toFixed(0) + ' MB';
    const kb = bytes / 1024;
    if (kb >= 1) return kb.toFixed(0) + ' KB';
    return bytes + ' B';
  }

  // Toggle warn/crit classes on a gauge based on a percent reading.
  // `invert=true` means "low value is bad" (e.g., disk free %).
  function applyAlert(el, pct, warnAt, critAt, invert) {
    if (!el || pct == null || isNaN(pct)) return;
    el.classList.remove('warn', 'crit');
    const x = invert ? 100 - pct : pct;
    if (x >= critAt) el.classList.add('crit');
    else if (x >= warnAt) el.classList.add('warn');
  }

  // ─── Generic live-scroll line chart factory ──────────────────
  function createLiveChart({ el, yAxes, series }) {
    const chart = echarts.init(el, null, { renderer: 'canvas' });
    const buffers = series.map(() => []);

    function buildOption() {
      const narrow = isNarrow();
      const now = Date.now();
      return {
        backgroundColor: 'transparent',
        textStyle: { color: '#c5c9d9' },
        color: series.map(s => s.color),
        animation: false,
        tooltip: {
          trigger: 'axis',
          backgroundColor: '#1a1d27',
          borderColor: '#2e3345',
          textStyle: { color: '#e4e6ed', fontSize: 12 },
          axisPointer: { lineStyle: { color: '#3e4358' } },
          valueFormatter: (v) => (typeof v === 'number' ? v.toFixed(2) : v),
        },
        grid: {
          left: narrow ? 38 : 46,
          right: yAxes.length > 1 ? (narrow ? 40 : 50) : 10,
          top: 10,
          bottom: 22,
        },
        xAxis: {
          type: 'time',
          min: now - WINDOW_MS,
          max: now,
          axisLine: { lineStyle: { color: '#2e3345' } },
          axisLabel: { color: '#9ba0b5', fontSize: 10, hideOverlap: true },
          splitNumber: narrow ? 4 : 6,
          splitLine: {
            show: true,
            lineStyle: { color: 'rgba(120, 130, 160, 0.12)', width: 1 },
          },
          minorTick: { show: true, splitNumber: 4 },
          minorSplitLine: {
            show: true,
            lineStyle: { color: 'rgba(120, 130, 160, 0.05)', width: 1 },
          },
        },
        yAxis: yAxes.map((y, i) => ({
          type: y.type || 'value',
          name: narrow ? '' : (y.name || ''),
          position: y.position || (i === 0 ? 'left' : 'right'),
          min: y.min,
          max: y.max,
          interval: y.interval,
          logBase: y.logBase,
          nameTextStyle: { color: y.color || '#9ba0b5', fontSize: 10 },
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: {
            color: y.color || '#9ba0b5',
            fontSize: 10,
            formatter: y.formatter,
          },
          splitLine: y.splitLine !== false
            ? { lineStyle: { color: 'rgba(120, 130, 160, 0.12)', width: 1 } }
            : { show: false },
        })),
        series: series.map((s, i) => ({
          name: s.name,
          type: 'line',
          showSymbol: false,
          yAxisIndex: s.yAxisIndex || 0,
          data: buffers[i],
          lineStyle: { width: s.width || 1.6, color: s.color },
        })),
      };
    }

    chart.setOption(buildOption());

    function onResize() {
      chart.setOption(buildOption(), { replaceMerge: ['grid', 'yAxis'] });
      chart.resize();
    }
    window.addEventListener('resize', onResize);

    function tick() {
      const now = Date.now();
      chart.setOption({ xAxis: { min: now - WINDOW_MS, max: now } });
    }

    function push(ts, values) {
      for (let i = 0; i < series.length; i++) {
        buffers[i].push([ts, values[i]]);
        while (buffers[i].length > BUFFER_POINTS) buffers[i].shift();
      }
      chart.setOption({
        series: buffers.map(b => ({ data: b })),
      });
    }

    // Replace buffers with a batch of rows and repaint once.
    // Used on first load so ECharts sees the full backfill in a single render
    // instead of drawing a diagonal across sparsely-populated buffers.
    function pushBatch(rows) {
      for (let i = 0; i < series.length; i++) buffers[i].length = 0;
      for (const row of rows) {
        for (let i = 0; i < series.length; i++) {
          buffers[i].push([row.ts, row.values[i]]);
        }
      }
      for (let i = 0; i < series.length; i++) {
        while (buffers[i].length > BUFFER_POINTS) buffers[i].shift();
      }
      chart.setOption({
        series: buffers.map(b => ({ data: b })),
      });
    }

    return { push, pushBatch, tick };
  }

  // ─── Chart 1: CPU % + RAM GB ─────────────────────────────────
  const cpuMemChart = createLiveChart({
    el: document.getElementById('vmCpuMemChart'),
    yAxes: [
      { name: '%', min: 0, max: 100, interval: 20 },
      { name: 'GB', color: '#10b981', splitLine: false },
    ],
    series: [
      { name: 'CPU %',  color: '#3b82f6', yAxisIndex: 0, width: 1.8 },
      { name: 'RAM GB', color: '#10b981', yAxisIndex: 1, width: 1.8 },
    ],
  });

  // ─── Chart 2: Net RX + TX (log-scale KB/s) ───────────────────
  const netChart = createLiveChart({
    el: document.getElementById('vmNetChart'),
    yAxes: [
      {
        type: 'log',
        logBase: 10,
        name: 'KB/s',
        min: 0.01,
        max: 10000,
        color: '#f59e0b',
        formatter: (v) => {
          if (v >= 1000) return (v / 1000) + 'M';
          if (v >= 1) return v + 'K';
          return (v * 1000) + 'B';
        },
      },
    ],
    series: [
      { name: 'Net RX', color: '#f59e0b', width: 1.6 },
      { name: 'Net TX', color: '#fcd34d', width: 1.6 },
    ],
  });

  // ─── Shared tick: drift both charts' xAxis at 30fps ──────────
  setInterval(() => { cpuMemChart.tick(); netChart.tick(); }, 33);

  // ─── Status badges (Busy / Active / Idle) ───────────────────
  // Updates a badge span with a text label and level class. `level` drives
  // the color via .vm-badge.busy / .active / .idle in CSS.
  function setBadge(el, level, text) {
    if (!el) return;
    el.classList.remove('busy', 'active', 'idle');
    if (level) el.classList.add(level);
    el.textContent = text;
  }

  function cpuBadge(pct) {
    if (pct == null || isNaN(pct)) return { level: null, text: '--' };
    if (pct >= 70) return { level: 'busy', text: 'Busy' };
    if (pct >= 30) return { level: 'active', text: 'Active' };
    return { level: 'idle', text: 'Idle' };
  }

  function memBadge(usedGb, totalGb) {
    if (!totalGb || totalGb <= 0) return { level: null, text: '--' };
    const pct = (usedGb / totalGb) * 100;
    if (pct >= 85) return { level: 'busy', text: 'Tight' };
    if (pct >= 60) return { level: 'active', text: 'Active' };
    return { level: 'idle', text: 'Idle' };
  }

  // Net uses a 5-sample rolling sum of RX+TX (in bytes/s) so the badge
  // does not flicker on every 1-sec spike.
  const netWindow = [];
  const NET_WINDOW_LEN = 5;
  function netBadge(rxBps, txBps) {
    netWindow.push((rxBps || 0) + (txBps || 0));
    while (netWindow.length > NET_WINDOW_LEN) netWindow.shift();
    const avg = netWindow.reduce((s, v) => s + v, 0) / netWindow.length;
    if (avg >= 1_048_576) return { level: 'busy', text: 'Busy' };      // >=1 MB/s
    if (avg >=   102_400) return { level: 'active', text: 'Active' };  // >=100 KB/s
    return { level: 'idle', text: 'Idle' };
  }

  // ─── Sample handler (from WS or backfill) ────────────────────
  // applyGauges updates all top-row cards and badges based on one sample.
  // It does NOT touch the charts — the chart path is separate so backfill
  // can repaint in one setOption call (see pushBatch).
  function applyGauges(sample) {
    cpuEl.textContent = sample.cpu_pct === null ? '--' : sample.cpu_pct.toFixed(1) + ' %';
    const cb = cpuBadge(sample.cpu_pct);
    setBadge(cpuBadgeEl, cb.level, cb.text);

    if (sample.mem_total_gb) {
      memEl.textContent = sample.mem_used_gb.toFixed(1) + ' / ' + sample.mem_total_gb.toFixed(1) + ' GB';
    } else {
      memEl.textContent = (sample.mem_used_gb || 0).toFixed(1) + ' GB';
    }
    const mb = memBadge(sample.mem_used_gb, sample.mem_total_gb);
    setBadge(memBadgeEl, mb.level, mb.text);

    netEl.textContent = fmtBytes(sample.net_rx_bps) + ' / ' + fmtBytes(sample.net_tx_bps);
    const nb = netBadge(sample.net_rx_bps, sample.net_tx_bps);
    setBadge(netBadgeEl, nb.level, nb.text);

    if (sample.disk_free_gb != null) {
      const total = sample.disk_total_gb ? ' / ' + sample.disk_total_gb.toFixed(0) + ' GB' : ' GB';
      diskFreeEl.textContent = sample.disk_free_gb.toFixed(1) + total;
      if (sample.disk_total_gb) {
        const freePct = (sample.disk_free_gb / sample.disk_total_gb) * 100;
        applyAlert(diskGauge, freePct, 20, 10, true);
      }
    } else {
      diskFreeEl.textContent = '-- GB';
    }

    if (sample.pagefile_used_gb != null) {
      const total = sample.pagefile_total_gb ? ' / ' + sample.pagefile_total_gb.toFixed(0) + ' GB' : ' GB';
      pagefileEl.textContent = sample.pagefile_used_gb.toFixed(1) + total;
      if (sample.pagefile_total_gb) {
        const usedPct = (sample.pagefile_used_gb / sample.pagefile_total_gb) * 100;
        applyAlert(pagefileGauge, usedPct, 75, 90, false);
      }
    } else {
      pagefileEl.textContent = '-- GB';
    }

    agentsEl.textContent = fmtMem(sample.agents_mem_mb);
    if (uptimeEl) uptimeEl.textContent = 'up ' + fmtUptime(sample.uptime_s);
  }

  function handleSample(sample) {
    const t = sample.ts * 1000;
    cpuMemChart.push(t, [
      sample.cpu_pct,
      sample.mem_used_gb,
    ]);
    netChart.push(t, [
      Math.max(0.01, (sample.net_rx_bps || 0) / 1024),
      Math.max(0.01, (sample.net_tx_bps || 0) / 1024),
    ]);
    applyGauges(sample);
  }

  // Backfill uses pushBatch so ECharts renders all historical points in a
  // single setOption call. Per-sample push would leave the chart drawing a
  // diagonal line across sparsely-populated buffers on first paint.
  fetch('/api/metrics/recent?minutes=2')
    .then((r) => r.json())
    .then((rows) => {
      if (!rows.length) return;
      const cpuRamData = rows.map((r) => ({
        ts: r.ts * 1000,
        values: [r.cpu_pct, r.mem_used_gb],
      }));
      const netData = rows.map((r) => ({
        ts: r.ts * 1000,
        values: [
          Math.max(0.01, (r.net_rx_bps || 0) / 1024),
          Math.max(0.01, (r.net_tx_bps || 0) / 1024),
        ],
      }));
      cpuMemChart.pushBatch(cpuRamData);
      netChart.pushBatch(netData);
      applyGauges(rows[rows.length - 1]);
    })
    .catch(() => {});

  // ─── Per-agent process RSS table (5s polling when open) ─────
  // Rows are grouped by agent (identified via parent-chain command-line match).
  // Each agent-summary row is clickable to reveal its child process rows.
  const expandedAgents = new Set();

  function renderAgents(data) {
    const agents = data && Array.isArray(data.agents) ? data.agents : [];
    const unattributed = data && Array.isArray(data.unattributed) ? data.unattributed : [];
    const totalProcs = agents.reduce((s, a) => s + a.process_count, 0) + unattributed.length;
    if (agentsCountEl) {
      agentsCountEl.textContent = `(${agents.length} agent${agents.length === 1 ? '' : 's'}, ${totalProcs} proc${totalProcs === 1 ? '' : 's'})`;
    }
    if (topAgentBadgeEl) {
      if (agents.length > 0) {
        const top = agents[0];
        const rssText = top.total_rss_mb >= 1024
          ? (top.total_rss_mb / 1024).toFixed(2) + ' GB'
          : top.total_rss_mb.toFixed(0) + ' MB';
        topAgentBadgeEl.textContent = `Top: ${top.agent} · ${rssText}`;
        topAgentBadgeEl.style.display = '';
      } else {
        topAgentBadgeEl.textContent = '';
        topAgentBadgeEl.style.display = 'none';
      }
    }
    if (!agentsTbody) return;

    const rows = [];
    for (const a of agents) {
      const expanded = expandedAgents.has(a.agent);
      rows.push(`
        <tr class="agent-summary${expanded ? ' expanded' : ''}" data-agent="${a.agent}">
          <td><span class="agent-toggle">${expanded ? '▾' : '▸'}</span> ${a.agent}</td>
          <td class="num">${a.process_count}</td>
          <td class="num">${a.total_rss_mb.toFixed(0)}</td>
          <td class="num">${a.total_cpu_pct.toFixed(2)}</td>
        </tr>
      `);
      if (expanded) {
        for (const p of a.processes) {
          rows.push(`
            <tr class="agent-proc-row" data-parent="${a.agent}">
              <td class="proc-name"><span class="proc-indent"></span>${p.name} <span class="proc-pid">${p.pid}</span></td>
              <td class="num">-</td>
              <td class="num">${p.rss_mb.toFixed(0)}</td>
              <td class="num">${p.cpu_pct == null ? '--' : p.cpu_pct.toFixed(2)}</td>
            </tr>
          `);
        }
      }
    }

    if (unattributed.length) {
      rows.push(`
        <tr class="agent-unattributed-header"><td colspan="4">Unattributed (${unattributed.length})</td></tr>
      `);
      for (const p of unattributed) {
        rows.push(`
          <tr class="agent-proc-row">
            <td class="proc-name"><span class="proc-indent"></span>${p.name} <span class="proc-pid">${p.pid}</span></td>
            <td class="num">-</td>
            <td class="num">${p.rss_mb.toFixed(0)}</td>
            <td class="num">${p.cpu_pct == null ? '--' : p.cpu_pct.toFixed(2)}</td>
          </tr>
        `);
      }
    }

    agentsTbody.innerHTML = rows.join('');
  }

  if (agentsTbody) {
    agentsTbody.addEventListener('click', (ev) => {
      const tr = ev.target.closest('tr.agent-summary');
      if (!tr) return;
      const name = tr.dataset.agent;
      if (!name) return;
      if (expandedAgents.has(name)) expandedAgents.delete(name);
      else expandedAgents.add(name);
      fetchAgents();
    });
  }

  async function fetchAgents() {
    try {
      const r = await fetch('/api/metrics/agents');
      if (r.ok) renderAgents(await r.json());
    } catch {}
  }

  fetchAgents();
  let agentsTimer = null;
  function startAgentsPolling() {
    if (agentsTimer) return;
    agentsTimer = setInterval(fetchAgents, 5000);
  }
  function stopAgentsPolling() {
    if (agentsTimer) { clearInterval(agentsTimer); agentsTimer = null; }
  }

  if (agentsDetailEl) {
    agentsDetailEl.addEventListener('toggle', () => {
      if (agentsDetailEl.open) { fetchAgents(); startAgentsPolling(); }
      else stopAgentsPolling();
    });
  }

  // ─── Disk caches panel (fetched on open + manual refresh) ───
  function renderCaches(data) {
    const entries = data && Array.isArray(data.entries) ? data.entries : [];
    if (cachesTotalEl) cachesTotalEl.textContent = `(${fmtSize(data.total_bytes || 0)})`;
    if (!cachesTbody) return;
    cachesTbody.innerHTML = entries.map((e) => {
      let tag, tagClass;
      if (!e.exists) { tag = 'MISSING'; tagClass = 'missing'; }
      else if (e.protected) { tag = 'PROTECTED'; tagClass = 'protected'; }
      else { tag = 'SAFE TO CLEAR'; tagClass = 'safe'; }
      return `
        <tr>
          <td>
            <div>${e.label}</div>
            <div class="vm-cache-note" style="margin-top:2px">${(e.paths || []).join('<br>')}</div>
          </td>
          <td class="num">${e.exists ? fmtSize(e.size_bytes) : '--'}</td>
          <td><span class="vm-cache-tag ${tagClass}">${tag}</span></td>
          <td><div class="vm-cache-note">${e.note || ''}</div></td>
        </tr>
      `;
    }).join('');
  }

  async function fetchCaches({ force = false } = {}) {
    if (cachesRefreshBtn) cachesRefreshBtn.classList.add('spinning');
    try {
      const r = await fetch('/api/disk/caches' + (force ? '?refresh=1' : ''));
      if (r.ok) renderCaches(await r.json());
    } catch {}
    finally {
      if (cachesRefreshBtn) cachesRefreshBtn.classList.remove('spinning');
    }
  }

  if (cachesDetailEl) {
    cachesDetailEl.addEventListener('toggle', () => {
      if (cachesDetailEl.open) fetchCaches();
    });
  }

  if (cachesRefreshBtn) {
    cachesRefreshBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      fetchCaches({ force: true });
    });
  }

  let ws = null;
  let retryDelay = 1000;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws/metrics`);
    ws.onopen = () => {
      statusEl.textContent = 'live';
      statusEl.className = 'vm-status ok';
      retryDelay = 1000;
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'sample' && msg.data) handleSample(msg.data);
      } catch {}
    };
    ws.onclose = () => {
      statusEl.textContent = 'reconnecting…';
      statusEl.className = 'vm-status warn';
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30_000);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  connect();
})();
