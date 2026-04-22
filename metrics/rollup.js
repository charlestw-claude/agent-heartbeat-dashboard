const { getDb } = require('../db/database');

// Rolls raw 1-second samples up into 1-minute and hourly aggregates.
// Runs on minute and hour boundaries, processing the *just-completed* window
// so rollup rows are always based on a complete set of samples.
//
// Retention:
//   raw   → trimmed by archive.js after daily export
//   1min  → trimmed to 30 days here
//   hourly→ kept forever

const ONE_MIN_MS = 60_000;
const ONE_HOUR_MS = 3_600_000;
const MINUTE_RETENTION_DAYS = 30;

function aggregateWindow(db, fromTs, toTs) {
  return db.prepare(`
    SELECT
      AVG(cpu_pct)         AS cpu_pct_avg,
      MAX(cpu_pct)         AS cpu_pct_max,
      AVG(mem_used_gb)     AS mem_used_gb_avg,
      MAX(mem_used_gb)     AS mem_used_gb_max,
      AVG(net_rx_bps)      AS net_rx_bps_avg,
      AVG(net_tx_bps)      AS net_tx_bps_avg,
      AVG(disk_read_bps)   AS disk_read_bps_avg,
      AVG(disk_write_bps)  AS disk_write_bps_avg,
      COUNT(*)             AS sample_count
    FROM vm_metrics_raw
    WHERE ts >= ? AND ts < ?
  `).get(fromTs, toTs);
}

function rollupMinute(db) {
  const now = Math.floor(Date.now() / 1000);
  const currentMinStart = now - (now % 60);
  const targetMin = currentMinStart - 60; // previous (completed) minute
  const r = aggregateWindow(db, targetMin, targetMin + 60);
  if (!r || !r.sample_count) return;
  db.prepare(`
    INSERT OR REPLACE INTO vm_metrics_1min
      (ts, cpu_pct_avg, cpu_pct_max, mem_used_gb_avg, mem_used_gb_max,
       net_rx_bps_avg, net_tx_bps_avg, disk_read_bps_avg, disk_write_bps_avg, sample_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    targetMin, r.cpu_pct_avg, r.cpu_pct_max, r.mem_used_gb_avg, r.mem_used_gb_max,
    r.net_rx_bps_avg, r.net_tx_bps_avg, r.disk_read_bps_avg, r.disk_write_bps_avg, r.sample_count
  );
}

function rollupHour(db) {
  const now = Math.floor(Date.now() / 1000);
  const currentHourStart = now - (now % 3600);
  const targetHour = currentHourStart - 3600;
  const r = db.prepare(`
    SELECT
      AVG(cpu_pct_avg)        AS cpu_pct_avg,
      MAX(cpu_pct_max)        AS cpu_pct_max,
      AVG(mem_used_gb_avg)    AS mem_used_gb_avg,
      MAX(mem_used_gb_max)    AS mem_used_gb_max,
      AVG(net_rx_bps_avg)     AS net_rx_bps_avg,
      AVG(net_tx_bps_avg)     AS net_tx_bps_avg,
      AVG(disk_read_bps_avg)  AS disk_read_bps_avg,
      AVG(disk_write_bps_avg) AS disk_write_bps_avg,
      SUM(sample_count)       AS sample_count
    FROM vm_metrics_1min
    WHERE ts >= ? AND ts < ?
  `).get(targetHour, targetHour + 3600);
  if (!r || !r.sample_count) return;
  db.prepare(`
    INSERT OR REPLACE INTO vm_metrics_hourly
      (ts, cpu_pct_avg, cpu_pct_max, mem_used_gb_avg, mem_used_gb_max,
       net_rx_bps_avg, net_tx_bps_avg, disk_read_bps_avg, disk_write_bps_avg, sample_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    targetHour, r.cpu_pct_avg, r.cpu_pct_max, r.mem_used_gb_avg, r.mem_used_gb_max,
    r.net_rx_bps_avg, r.net_tx_bps_avg, r.disk_read_bps_avg, r.disk_write_bps_avg, r.sample_count
  );
}

function trimMinuteRetention(db) {
  const cutoff = Math.floor(Date.now() / 1000) - (MINUTE_RETENTION_DAYS * 86400);
  db.prepare('DELETE FROM vm_metrics_1min WHERE ts < ?').run(cutoff);
}

let minuteTimer = null;
let hourTimer = null;

function scheduleAtNext(intervalMs, offsetMs, fn) {
  const now = Date.now();
  const nextBoundary = Math.ceil(now / intervalMs) * intervalMs + offsetMs;
  const wait = Math.max(100, nextBoundary - now);
  setTimeout(() => {
    try { fn(); } catch (err) { console.error('[rollup]', err.message); }
    const handle = setInterval(() => {
      try { fn(); } catch (err) { console.error('[rollup]', err.message); }
    }, intervalMs);
    if (intervalMs === ONE_MIN_MS) minuteTimer = handle;
    else hourTimer = handle;
  }, wait);
}

function start() {
  const db = getDb();
  // Minute rollup: fire 5s after each minute boundary so the just-completed
  // minute's samples have all been flushed from the collector buffer.
  scheduleAtNext(ONE_MIN_MS, 5_000, () => { rollupMinute(db); });
  // Hour rollup: fire 10s after each hour boundary.
  scheduleAtNext(ONE_HOUR_MS, 10_000, () => { rollupHour(db); trimMinuteRetention(db); });
  console.log('[rollup] scheduled');
}

function stop() {
  if (minuteTimer) { clearInterval(minuteTimer); minuteTimer = null; }
  if (hourTimer) { clearInterval(hourTimer); hourTimer = null; }
}

module.exports = { start, stop, rollupMinute, rollupHour, trimMinuteRetention };
