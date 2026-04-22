// VM realtime metrics panel. Streams 1s samples over WebSocket and renders
// a rolling 2-minute line chart. A rAF loop shifts the xAxis window
// continuously against wall-clock time so the chart drifts left smoothly
// between sample arrivals. Gauges show the latest sample.

(function () {
  const BUFFER_POINTS = 900;        // keep up to 15 min in memory
  const WINDOW_MS = 2 * 60 * 1000;  // visible: 2 minutes — short enough to see drift
  const chartEl = document.getElementById('vmMetricsChart');
  const statusEl = document.getElementById('vmMetricsStatus');
  const cpuEl = document.getElementById('vmCpu');
  const memEl = document.getElementById('vmMem');
  const netEl = document.getElementById('vmNet');
  const diskEl = document.getElementById('vmDisk');
  if (!chartEl) return;

  const chart = echarts.init(chartEl, null, { renderer: 'canvas' });
  const tsData = [];
  const cpuData = [];
  const memData = [];
  const rxData = [];
  const txData = [];

  const COLORS = {
    cpu:  '#3b82f6',
    mem:  '#10b981',
    rx:   '#f59e0b',
    tx:   '#a855f7',
  };

  function isNarrow() {
    return window.innerWidth <= 640;
  }

  function buildOption() {
    const narrow = isNarrow();
    const now = Date.now();
    return {
      backgroundColor: 'transparent',
      textStyle: { color: '#c5c9d9' },
      color: [COLORS.cpu, COLORS.mem, COLORS.rx, COLORS.tx],
      animation: false,
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#1a1d27',
        borderColor: '#2e3345',
        textStyle: { color: '#e4e6ed', fontSize: 12 },
        axisPointer: { lineStyle: { color: '#3e4358' } },
      },
      legend: {
        data: ['CPU %', 'RAM GB', 'Net RX MB/s', 'Net TX MB/s'],
        top: 0,
        textStyle: { color: '#c5c9d9', fontSize: 11 },
        itemWidth: 14,
        itemHeight: 8,
        itemGap: narrow ? 8 : 14,
      },
      grid: {
        left: narrow ? 38 : 48,
        right: narrow ? 42 : 58,
        top: narrow ? 52 : 36,
        bottom: 30,
        containLabel: false,
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
      yAxis: [
        {
          type: 'value',
          name: '%',
          min: 0,
          max: 100,
          position: 'left',
          interval: 20,
          nameTextStyle: { color: '#9ba0b5', fontSize: 10 },
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { color: '#9ba0b5', fontSize: 10 },
          splitLine: { lineStyle: { color: 'rgba(120, 130, 160, 0.12)', width: 1 } },
        },
        {
          type: 'value',
          name: narrow ? '' : 'GB / MB/s',
          position: 'right',
          nameTextStyle: { color: '#9ba0b5', fontSize: 10 },
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { color: '#9ba0b5', fontSize: 10 },
          splitLine: { show: false },
        },
      ],
      series: [
        { name: 'CPU %',       type: 'line', showSymbol: false, yAxisIndex: 0, data: cpuData, lineStyle: { width: 1.8, color: COLORS.cpu } },
        { name: 'RAM GB',      type: 'line', showSymbol: false, yAxisIndex: 1, data: memData, lineStyle: { width: 1.8, color: COLORS.mem } },
        { name: 'Net RX MB/s', type: 'line', showSymbol: false, yAxisIndex: 1, data: rxData,  lineStyle: { width: 1.4, color: COLORS.rx } },
        { name: 'Net TX MB/s', type: 'line', showSymbol: false, yAxisIndex: 1, data: txData,  lineStyle: { width: 1.4, color: COLORS.tx } },
      ],
    };
  }

  chart.setOption(buildOption());

  window.addEventListener('resize', () => {
    chart.setOption(buildOption(), { replaceMerge: ['grid', 'yAxis', 'legend'] });
    chart.resize();
  });

  // Continuous scroll: every ~33ms (30fps), shift xAxis to [now-WINDOW, now].
  // Series data is untouched here; new points arrive via push(). ECharts
  // auto-clips points outside the xAxis range, so the line visibly drifts left.
  function tick() {
    const now = Date.now();
    chart.setOption({
      xAxis: { min: now - WINDOW_MS, max: now },
    });
  }
  setInterval(tick, 33);

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
    while (tsData.length > BUFFER_POINTS) {
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

  // Backfill the last 2 minutes so the chart isn't empty on first load
  fetch('/api/metrics/recent?minutes=2')
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
