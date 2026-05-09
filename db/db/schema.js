const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || './data/stock-tracker.db';

let db;

function getDb() {
  if (db) return db;

  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  initSchema();
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      market TEXT NOT NULL DEFAULT 'sh',
      name TEXT NOT NULL,
      reason TEXT,
      added_price REAL NOT NULL,
      current_price REAL,
      highest_price REAL,
      lowest_price REAL,
      max_drawdown REAL DEFAULT 0,
      change_percent REAL DEFAULT 0,
      daily_change REAL DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS stock_prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stock_id INTEGER NOT NULL,
      price REAL NOT NULL,
      high REAL,
      low REAL,
      change_percent REAL DEFAULT 0,
      recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (stock_id) REFERENCES stocks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_stock_prices_stock_id ON stock_prices(stock_id);
    CREATE INDEX IF NOT EXISTS idx_stock_prices_recorded_at ON stock_prices(recorded_at);

    CREATE TABLE IF NOT EXISTS research_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      institution TEXT DEFAULT '',
      stock_code TEXT DEFAULT '',
      stock_name TEXT DEFAULT '',
      url TEXT DEFAULT '',
      summary TEXT DEFAULT '',
      rating TEXT DEFAULT '',
      report_date TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_research_stock_code ON research_reports(stock_code);
    CREATE INDEX IF NOT EXISTS idx_research_report_date ON research_reports(report_date);
  `);

  // Add columns for backward compatibility with existing databases
  try { db.exec("ALTER TABLE stocks ADD COLUMN join_date TEXT DEFAULT ''"); } catch(e) {}
  try { db.exec("ALTER TABLE stocks ADD COLUMN daily_change REAL DEFAULT 0"); } catch(e) {}

  // Migrate existing stocks: set join_date from created_at if empty
  try {
    db.prepare("UPDATE stocks SET join_date = substr(created_at,1,10) WHERE join_date IS NULL OR join_date = ''").run();
  } catch(e) {}
}

module.exports = { getDb };
