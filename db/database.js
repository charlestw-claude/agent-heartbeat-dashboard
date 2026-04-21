const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'heartbeat.db');
let db = null;

function initDb() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS heartbeats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('online', 'offline')),
      pid INTEGER,
      source TEXT NOT NULL DEFAULT 'scheduled',
      timestamp DATETIME DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name TEXT NOT NULL,
      event_type TEXT NOT NULL,
      details TEXT,
      timestamp DATETIME DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_heartbeats_agent_ts
      ON heartbeats(agent_name, timestamp);

    CREATE INDEX IF NOT EXISTS idx_heartbeats_ts
      ON heartbeats(timestamp);

    CREATE INDEX IF NOT EXISTS idx_events_ts
      ON events(timestamp);
  `);

  // Migration: add source column to existing heartbeats tables (idempotent)
  const hasSource = db
    .prepare("SELECT 1 FROM pragma_table_info('heartbeats') WHERE name='source'")
    .get();
  if (!hasSource) {
    db.exec("ALTER TABLE heartbeats ADD COLUMN source TEXT NOT NULL DEFAULT 'scheduled'");
    console.log('Migration: added source column to heartbeats');
  }

  // Auto-cleanup: remove heartbeats older than 90 days
  db.prepare(`
    DELETE FROM heartbeats WHERE timestamp < datetime('now', '-90 days')
  `).run();

  db.prepare(`
    DELETE FROM events WHERE timestamp < datetime('now', '-90 days')
  `).run();

  console.log('Database initialized:', DB_PATH);
  return db;
}

function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

module.exports = { initDb, getDb };
