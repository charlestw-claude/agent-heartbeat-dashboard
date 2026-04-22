const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { getDb } = require('../db/database');

// Daily archive job: at 00:05 local time, export the previous day's raw
// samples to a 7z-compressed CSV and delete raw rows older than the
// retention window (default 48h — keeps the realtime chart responsive).

const SEVEN_ZIP = process.env.SEVEN_ZIP_PATH || 'C:\\Program Files\\7-Zip\\7z.exe';
const RAW_RETENTION_HOURS = 48;
const ARCHIVE_DIR = path.join(__dirname, '..', 'db', 'archive', 'raw');

function dayBoundsUtcOffset(date) {
  // Returns unix seconds [start, end) for the local-time day containing `date`.
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0);
  return [Math.floor(start.getTime() / 1000), Math.floor(end.getTime() / 1000)];
}

function dateTag(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function archiveDay(date) {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const [from, to] = dayBoundsUtcOffset(date);
  const tag = dateTag(date);
  const csvPath = path.join(ARCHIVE_DIR, `${tag}.csv`);
  const sevenPath = path.join(ARCHIVE_DIR, `${tag}.csv.7z`);

  if (fs.existsSync(sevenPath)) {
    console.log(`[archive] ${tag} already archived; skipping`);
    return { tag, skipped: true };
  }

  const db = getDb();
  const rows = db.prepare(`
    SELECT ts, cpu_pct, mem_used_gb, mem_total_gb,
           net_rx_bps, net_tx_bps, disk_read_bps, disk_write_bps
    FROM vm_metrics_raw
    WHERE ts >= ? AND ts < ?
    ORDER BY ts
  `).all(from, to);

  if (rows.length === 0) {
    console.log(`[archive] ${tag} has no rows; skipping`);
    return { tag, empty: true };
  }

  const header = 'ts,cpu_pct,mem_used_gb,mem_total_gb,net_rx_bps,net_tx_bps,disk_read_bps,disk_write_bps\n';
  const fmt = (v) => (v === null || v === undefined ? '' : typeof v === 'number' ? v.toFixed(3) : String(v));
  const stream = fs.createWriteStream(csvPath);
  stream.write(header);
  for (const r of rows) {
    stream.write(`${r.ts},${fmt(r.cpu_pct)},${fmt(r.mem_used_gb)},${fmt(r.mem_total_gb)},${fmt(r.net_rx_bps)},${fmt(r.net_tx_bps)},${fmt(r.disk_read_bps)},${fmt(r.disk_write_bps)}\n`);
  }
  await new Promise((resolve, reject) => { stream.end((err) => err ? reject(err) : resolve()); });

  await new Promise((resolve, reject) => {
    execFile(SEVEN_ZIP, ['a', '-t7z', '-mx=9', sevenPath, csvPath], (err, stdout, stderr) => {
      if (err) return reject(new Error(`7z failed: ${err.message} ${stderr}`));
      resolve();
    });
  });

  try { fs.unlinkSync(csvPath); } catch {}
  console.log(`[archive] ${tag}: ${rows.length} rows → ${path.basename(sevenPath)}`);
  return { tag, rows: rows.length, path: sevenPath };
}

function trimRawRetention() {
  const cutoff = Math.floor(Date.now() / 1000) - (RAW_RETENTION_HOURS * 3600);
  const db = getDb();
  const res = db.prepare('DELETE FROM vm_metrics_raw WHERE ts < ?').run(cutoff);
  if (res.changes > 0) console.log(`[archive] trimmed ${res.changes} raw rows older than ${RAW_RETENTION_HOURS}h`);
  return res.changes;
}

async function runDailyArchive() {
  // Archive yesterday's samples, then trim raw older than retention.
  const yesterday = new Date(Date.now() - 86400_000);
  try {
    await archiveDay(yesterday);
    // Also backfill any previous day not yet archived (catches missed runs).
    for (let i = 2; i <= 7; i++) {
      const d = new Date(Date.now() - i * 86400_000);
      const tag = dateTag(d);
      const existing = path.join(ARCHIVE_DIR, `${tag}.csv.7z`);
      if (!fs.existsSync(existing)) {
        // Only archive if there are still rows for that day in raw
        const [from, to] = dayBoundsUtcOffset(d);
        const db = getDb();
        const count = db.prepare('SELECT COUNT(*) c FROM vm_metrics_raw WHERE ts >= ? AND ts < ?').get(from, to);
        if (count && count.c > 0) await archiveDay(d);
      }
    }
    trimRawRetention();
  } catch (err) {
    console.error('[archive] failed:', err.message);
  }
}

let scheduleTimer = null;

function scheduleDaily() {
  // Fire at 00:05 local time daily.
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 5, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  const wait = next.getTime() - now.getTime();
  scheduleTimer = setTimeout(() => {
    runDailyArchive().finally(() => scheduleDaily());
  }, wait);
  console.log(`[archive] next run: ${next.toISOString()}`);
}

function start() {
  scheduleDaily();
  // Also run a retention-trim pass at startup in case the process was down
  // past a daily boundary.
  setTimeout(() => {
    runDailyArchive().catch(() => {});
  }, 30_000);
}

function stop() {
  if (scheduleTimer) { clearTimeout(scheduleTimer); scheduleTimer = null; }
}

module.exports = { start, stop, runDailyArchive, archiveDay, trimRawRetention };
