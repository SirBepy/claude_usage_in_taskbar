"use strict";

const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "sync.db");

function initDb() {
  const db = new Database(DB_PATH);

  // Enable WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      link_code TEXT,
      link_expires_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      api_key TEXT UNIQUE NOT NULL,
      last_sync_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_devices_api_key ON devices(api_key);
    CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);

    CREATE TABLE IF NOT EXISTS usage_snapshots (
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      hour TEXT NOT NULL,
      session_pct REAL,
      weekly_pct REAL,
      session_resets_at TEXT,
      weekly_resets_at TEXT,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (device_id, hour)
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_user ON usage_snapshots(user_id, recorded_at);

    CREATE TABLE IF NOT EXISTS token_sessions (
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      cwd TEXT,
      date TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_creation_tokens INTEGER,
      turns INTEGER,
      started_at TEXT,
      last_active_at TEXT,
      recorded_at TEXT,
      PRIMARY KEY (device_id, session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_tokens_user ON token_sessions(user_id, recorded_at);
  `);

  return db;
}

module.exports = { initDb };
