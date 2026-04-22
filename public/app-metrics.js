// VM realtime metrics panel. Streams 1s samples over WebSocket and renders
// a rolling 15-minute line chart (CPU % + memory GB). Gauges read the
// latest sample.

(function () {
  const MAX_POINTS = 900; // 15 minutes at 1s
  const chartEl = document.getElementById('vmMetricsChart');
  const statusEl = document.getElementById('vmMetricsStatus');
  const cpuEl = document.getElementById('vmCpu');
  const memEl = document.getElementById('vmMem');
  const netEl = document.getElementById('vmNet');
  const diskEl = document.getElementById('vmDisk');
  if (!chartEl) return;

  const chart = echarts.init(chartEl);
  const tsData = [];
  const cpuData = [];
  const memData = [];
  const rxData = [];
  const txData = [];

  chart.setOption({
    tooltip: { trigger: 'axis' },
    legend: { data: ['CPU %', 'RAM GB', 'Net RX MB/s', 'Net TX MB/s'], top: 0 },
    grid: { left: 50, right: 60, top: 30, bottom: 40 },
    xAxis: { type: 'time' },
    yAxis: [
      { type: 'value', name: '%', min: 0, max: 100, position: 'left' },
      { type: 'value', name: 'GB / MB/s', position: 'right' },
    ],
    series: [
      { name: 'CPU %', type: 'line', showSymbol: false, yAxisIndex: 0, data: [], lineStyle: { width: 1.5 }, smooth: 0.2 },
      { name: 'RAM GB', type: 'line', showSymbol: false, yAxisIndex: 1, data: [], lineStyle: { width: 1.5 }, smooth: 0.2 },
      { name: 'Net RX MB/s', type: 'line', showSymbol: false, yAxisIndex: 1, data: [], lineStyle: { width: 1 } },
      { name: 'Net TX MB/s', type: 'line', showSymbol: false, yAxisIndex: 1, data: [], lineStyle: { width: 1 } },
    ],
  });

  window.addEventListener('resize', () => chart.resize());

  function fmtBytes(bps) {
    if (bps === null || bps === undefined) return '--';
    const mb = bps / 1048576;
    if (mb >= 1) return mb.toFixed(1) + ' MB/s';
    const kb = bps / 1024;
    if (kb >= 1) return kb.toFixed(0) + ' KB/s';
    return Math.round(bps) + ' B/s';
  }

  function push(sample) {
    const t = sample.ts * 1000;
    tsData.push(t);
    cpuData.push([t, sample.cpu_pct]);
    memData.push([t, sample.mem_used_gb]);
    rxData.push([t, sample.net_rx_bps / 1048576]);
    txData.push([t, sample.net_tx_bps / 1048576]);
    while (tsData.length > MAX_POINTS) {
      tsData.shift(); cpuData.shift(); memData.shift(); rxData.shift(); txData.shift();
    }
    chart.setOption({
      series: [
        { data: cpuData },
        { data: memData },
        { data: rxData },
        { data: txData },
      ],
    });

    cpuEl.textContent = sample.cpu_pct === null ? '--' : sample.cpu_pct.toFixed(1) + ' %';
    if (sample.mem_total_gb) {
      memEl.textContent = sample.mem_used_gb.toFixed(1) + ' / ' + sample.mem_total_gb.toFixed(1) + ' GB';
    } else {
      memEl.textContent = (sample.mem_used_gb || 0).toFixed(1) + ' GB';
    }
    netEl.textContent = fmtBytes(sample.net_rx_bps) + ' / ' + fmtBytes(sample.net_tx_bps);
    diskEl.textContent = fmtBytes(sample.disk_read_bps) + ' / ' + fmtBytes(sample.disk_write_bps);
  }

  // Backfill last 15 min so the chart isn't empty on first load
  fetch('/api/metrics/recent?minutes=15')
    .then((r) => r.json())
    .then((rows) => { for (const r of rows) push(r); })
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
        if (msg.type === 'sample' && msg.data) push(msg.data);
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
