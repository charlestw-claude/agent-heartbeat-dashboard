#!/usr/bin/env node
// Restore a day's archived raw samples from db/archive/raw/YYYY-MM-DD.csv.7z
// into a temporary table so ad-hoc queries can hit old data without touching
// the live vm_metrics_raw table.
//
// Usage:
//   node utils/restore-day.js 2026-04-15
//   node utils/restore-day.js 2026-04-15 --table vm_metrics_restore

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { initDb, getDb } = require('../db/database');

const SEVEN_ZIP = process.env.SEVEN_ZIP_PATH || 'C:\\Program Files\\7-Zip\\7z.exe';

function usage() {
  console.error('Usage: node utils/restore-day.js YYYY-MM-DD [--table NAME]');
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length < 1) usage();
const day = args[0];
if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) usage();

const tableIdx = args.indexOf('--table');
const tableName = tableIdx >= 0 ? args[tableIdx + 1] : 'vm_metrics_restore';
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
  console.error('Invalid --table name');
  process.exit(2);
}

const archiveFile = path.join(__dirname, '..', 'db', 'archive', 'raw', `${day}.csv.7z`);
if (!fs.existsSync(archiveFile)) {
  console.error(`Not found: ${archiveFile}`);
  process.exit(1);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-day-'));

execFile(SEVEN_ZIP, ['x', '-y', `-o${tmpDir}`, archiveFile], (err) => {
  if (err) {
    console.error('7z extract failed:', err.message);
    process.exit(1);
  }

  const csvPath = path.join(tmpDir, `${day}.csv`);
  const content = fs.readFileSync(csvPath, 'utf8');
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    console.error('Empty CSV');
    process.exit(1);
  }
  const header = lines[0].split(',');
  const expected = ['ts', 'cpu_pct', 'mem_used_gb', 'mem_total_gb', 'net_rx_bps', 'net_tx_bps', 'disk_read_bps', 'disk_write_bps'];
  if (JSON.stringify(header) !== JSON.stringify(expected)) {
    console.error('Unexpected header:', header);
    process.exit(1);
  }

  initDb();
  const db = getDb();

  db.exec(`DROP TABLE IF EXISTS ${tableName};`);
  db.exec(`
    CREATE TABLE ${tableName} (
      ts INTEGER PRIMARY KEY,
      cpu_pct REAL,
      mem_used_gb REAL,
      mem_total_gb REAL,
      net_rx_bps REAL,
      net_tx_bps REAL,
      disk_read_bps REAL,
      disk_write_bps REAL
    );
  `);

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO ${tableName}
      (ts, cpu_pct, mem_used_gb, mem_total_gb, net_rx_bps, net_tx_bps, disk_read_bps, disk_write_bps)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const parseNum = (v) => (v === '' ? null : Number(v));
  const tx = db.transaction(() => {
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      stmt.run(
        Number(parts[0]),
        parseNum(parts[1]), parseNum(parts[2]), parseNum(parts[3]),
        parseNum(parts[4]), parseNum(parts[5]), parseNum(parts[6]), parseNum(parts[7])
      );
    }
  });
  tx();

  const count = db.prepare(`SELECT COUNT(*) c FROM ${tableName}`).get().c;
  console.log(`Restored ${count} rows into ${tableName}`);
  console.log(`Query: sqlite3 ${path.join(__dirname, '..', 'db', 'heartbeat.db')} "SELECT * FROM ${tableName} LIMIT 5"`);

  // Clean up temp dir
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});
