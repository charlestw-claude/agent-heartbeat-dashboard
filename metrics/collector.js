const si = require('systeminformation');
const { getDb } = require('../db/database');

// Polls VM resource metrics once per second. Buffers samples in memory and
// flushes to SQLite every BATCH_FLUSH_MS to keep write amplification low.
// systeminformation gives cumulative counters for net/disk; we convert to
// per-second rates locally by diffing against the previous sample.

const POLL_INTERVAL_MS = 1000;
const BATCH_FLUSH_MS = 5000;

let lastNet = null;   // { rx_bytes, tx_bytes, ts }
let lastDisk = null;  // { rIO_bytes, wIO_bytes, ts }
let buffer = [];
let listeners = [];  // functions to notify on each sample (WS push)
let pollTimer = null;
let flushTimer = null;
let lastSample = null;

async function pollOnce() {
  const nowMs = Date.now();
  const ts = Math.floor(nowMs / 1000);

  try {
    const [cpu, mem, net, disk] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.networkStats(),
      si.disksIO(),
    ]);

    const cpu_pct = cpu && typeof cpu.currentLoad === 'number' ? cpu.currentLoad : null;
    const mem_total_gb = mem ? mem.total / 1073741824 : null;
    const mem_used_gb = mem ? (mem.total - mem.available) / 1073741824 : null;

    // Sum across network interfaces; systeminformation returns an array
    const rx_bytes = Array.isArray(net) ? net.reduce((s, n) => s + (n.rx_bytes || 0), 0) : 0;
    const tx_bytes = Array.isArray(net) ? net.reduce((s, n) => s + (n.tx_bytes || 0), 0) : 0;

    let net_rx_bps = null;
    let net_tx_bps = null;
    if (lastNet && nowMs > lastNet.ts) {
      const dt_s = (nowMs - lastNet.ts) / 1000;
      net_rx_bps = Math.max(0, (rx_bytes - lastNet.rx_bytes) / dt_s);
      net_tx_bps = Math.max(0, (tx_bytes - lastNet.tx_bytes) / dt_s);
    }
    lastNet = { rx_bytes, tx_bytes, ts: nowMs };

    let disk_read_bps = null;
    let disk_write_bps = null;
    if (disk && lastDisk && nowMs > lastDisk.ts) {
      const dt_s = (nowMs - lastDisk.ts) / 1000;
      if (typeof disk.rIO_sec === 'number' && disk.rIO_sec > 0) {
        // rIO_sec is already per-second on Windows
        disk_read_bps = (disk.rIO_sec || 0) * 512;
        disk_write_bps = (disk.wIO_sec || 0) * 512;
      } else {
        // Fallback: diff cumulative
        disk_read_bps = Math.max(0, ((disk.rIO || 0) - lastDisk.rIO_bytes) * 512 / dt_s);
        disk_write_bps = Math.max(0, ((disk.wIO || 0) - lastDisk.wIO_bytes) * 512 / dt_s);
      }
    }
    if (disk) lastDisk = { rIO_bytes: disk.rIO || 0, wIO_bytes: disk.wIO || 0, ts: nowMs };

    const sample = {
      ts,
      cpu_pct,
      mem_used_gb,
      mem_total_gb,
      net_rx_bps,
      net_tx_bps,
      disk_read_bps,
      disk_write_bps,
    };

    // Skip the first sample where per-second rates are still null
    if (net_rx_bps !== null) {
      buffer.push(sample);
      lastSample = sample;
      for (const fn of listeners) {
        try { fn(sample); } catch {}
      }
    }
  } catch (err) {
    console.error('[metrics] poll error:', err.message);
  }
}

function flush() {
  if (buffer.length === 0) return;
  const rows = buffer;
  buffer = [];
  try {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO vm_metrics_raw
        (ts, cpu_pct, mem_used_gb, mem_total_gb, net_rx_bps, net_tx_bps, disk_read_bps, disk_write_bps)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = db.transaction((items) => {
      for (const r of items) {
        stmt.run(r.ts, r.cpu_pct, r.mem_used_gb, r.mem_total_gb,
                 r.net_rx_bps, r.net_tx_bps, r.disk_read_bps, r.disk_write_bps);
      }
    });
    tx(rows);
  } catch (err) {
    console.error('[metrics] flush error:', err.message);
  }
}

function start() {
  if (pollTimer) return;
  pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
  flushTimer = setInterval(flush, BATCH_FLUSH_MS);
  console.log(`[metrics] collector started (poll=${POLL_INTERVAL_MS}ms, flush=${BATCH_FLUSH_MS}ms)`);
}

function stop() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  flush();
}

function onSample(fn) {
  listeners.push(fn);
  return () => { listeners = listeners.filter((f) => f !== fn); };
}

function getLastSample() { return lastSample; }

module.exports = { start, stop, onSample, getLastSample };
