//! Connection bootstrap + schema for the consolidated companion store.
//!
//! All three datasets share one shape: an `id`, a unix-second `timestamp`
//! (extracted from the wrapped struct's RFC3339 field at insert time), and a
//! `data` TEXT column holding the original Rust struct as a JSON blob. Storing
//! blobs keeps existing serde code untouched and makes struct evolution a
//! no-op for the schema.

use anyhow::Result;
use rusqlite::Connection;
use std::path::Path;

/// Current schema version, mirrored into `PRAGMA user_version` by
/// [`init_schema`]. Bump alongside any structural change.
pub const SCHEMA_VERSION: i64 = 1;

/// Opens (creating if absent) the SQLite database at `path` and ensures the
/// schema is present. The parent directory must already exist.
pub fn open_db(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    // WAL lets the app and the daemon read/write concurrently without blocking
    // each other on a single writer lock; the 5s busy_timeout makes a contended
    // write wait-and-retry instead of failing immediately with SQLITE_BUSY.
    // Set on every open so both processes coordinate on the same journal mode.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "busy_timeout", 5000)?;
    init_schema(&conn)?;
    Ok(conn)
}

/// Creates the three dataset tables, their timestamp indexes, and stamps the
/// schema version. Idempotent: safe to call on every open.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS usage_snapshots (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL,
          data      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_snapshots(timestamp);

        CREATE TABLE IF NOT EXISTS token_records (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL,
          data      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_token_ts ON token_records(timestamp);

        CREATE TABLE IF NOT EXISTS skill_events (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL,
          data      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_skill_ts ON skill_events(timestamp);
        "#,
    )?;
    conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    Ok(())
}

/// Reads back the stored schema version. Reserved for future migration logic.
pub fn schema_version(conn: &Connection) -> Result<i64> {
    let v: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    Ok(v)
}

/// Placeholder for forward migrations. At v1 there is nothing to migrate; a
/// later slice will branch on [`schema_version`].
pub fn run_migrations(conn: &Connection) -> Result<()> {
    let _ = schema_version(conn)?;
    Ok(())
}
