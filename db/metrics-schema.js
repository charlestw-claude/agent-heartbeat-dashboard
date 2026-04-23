const { getDb } = require('./database');

// New columns added after v1.2.0. Listed per table so we can ALTER TABLE
// each one idempotently — SQLite will throw "duplicate column name" on
// re-run, which we swallow, so the migration is safe across restarts.
const RAW_COLUMNS = {
  disk_free_gb: 'REAL',
  disk_total_gb: 'REAL',
  pagefile_used_gb: 'REAL',
  pagefile_total_gb: 'REAL',
  uptime_s: 'INTEGER',
  agents_mem_mb: 'REAL',
};

const ROLLUP_COLUMNS = {
  disk_free_gb_avg: 'REAL',
  pagefile_used_gb_avg: 'REAL',
  pagefile_used_gb_max: 'REAL',
  uptime_s_max: 'INTEGER',
  agents_mem_mb_avg: 'REAL',
  agents_mem_mb_max: 'REAL',
};

function addColumnIfMissing(db, table, name, type) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  } catch (err) {
    if (!/duplicate column name/i.test(err.message)) throw err;
  }
}

function initMetricsSchema() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS vm_metrics_raw (
      ts INTEGER PRIMARY KEY,
      cpu_pct REAL,
      mem_used_gb REAL,
      mem_total_gb REAL,
      net_rx_bps REAL,
      net_tx_bps REAL,
      disk_read_bps REAL,
      disk_write_bps REAL
    );

    CREATE TABLE IF NOT EXISTS vm_metrics_1min (
      ts INTEGER PRIMARY KEY,
      cpu_pct_avg REAL,
      cpu_pct_max REAL,
      mem_used_gb_avg REAL,
      mem_used_gb_max REAL,
      net_rx_bps_avg REAL,
      net_tx_bps_avg REAL,
      disk_read_bps_avg REAL,
      disk_write_bps_avg REAL,
      sample_count INTEGER
    );

    CREATE TABLE IF NOT EXISTS vm_metrics_hourly (
      ts INTEGER PRIMARY KEY,
      cpu_pct_avg REAL,
      cpu_pct_max REAL,
      mem_used_gb_avg REAL,
      mem_used_gb_max REAL,
      net_rx_bps_avg REAL,
      net_tx_bps_avg REAL,
      disk_read_bps_avg REAL,
      disk_write_bps_avg REAL,
      sample_count INTEGER
    );

    CREATE TABLE IF NOT EXISTS vm_metrics_jobs (
      job_name TEXT PRIMARY KEY,
      last_run_ts INTEGER NOT NULL
    );
  `);

  for (const [name, type] of Object.entries(RAW_COLUMNS)) {
    addColumnIfMissing(db, 'vm_metrics_raw', name, type);
  }
  for (const [name, type] of Object.entries(ROLLUP_COLUMNS)) {
    addColumnIfMissing(db, 'vm_metrics_1min', name, type);
    addColumnIfMissing(db, 'vm_metrics_hourly', name, type);
  }
}

module.exports = { initMetricsSchema };
