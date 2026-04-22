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
  const diskEl = document.getElementById('vmDisk');

  function isNarrow() { return window.innerWidth <= 640; }

  function fmtBytes(bps) {
    if (bps === null || bps === undefined) return '--';
    const mb = bps / 1048576;
    if (mb >= 1) return mb.toFixed(1) + ' MB/s';
    const kb = bps / 1024;
    if (kb >= 1) return kb.toFixed(0) + ' KB/s';
    return Math.round(bps) + ' B/s';
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

    return { push, tick };
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

  // ─── Sample handler (from WS or backfill) ────────────────────
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

    cpuEl.textContent = sample.cpu_pct === null ? '--' : sample.cpu_pct.toFixed(1) + ' %';
    if (sample.mem_total_gb) {
      memEl.textContent = sample.mem_used_gb.toFixed(1) + ' / ' + sample.mem_total_gb.toFixed(1) + ' GB';
    } else {
      memEl.textContent = (sample.mem_used_gb || 0).toFixed(1) + ' GB';
    }
    netEl.textContent = fmtBytes(sample.net_rx_bps) + ' / ' + fmtBytes(sample.net_tx_bps);
    diskEl.textContent = fmtBytes(sample.disk_read_bps) + ' / ' + fmtBytes(sample.disk_write_bps);
  }

  fetch('/api/metrics/recent?minutes=2')
    .then((r) => r.json())
    .then((rows) => { for (const r of rows) handleSample(r); })
    .catch(() => {});

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
