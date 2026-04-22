const { getDb } = require('./database');

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
}

module.exports = { initMetricsSchema };
