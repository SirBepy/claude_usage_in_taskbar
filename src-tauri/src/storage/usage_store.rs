//! CRUD for the `usage_snapshots` table.
//!
//! The index `timestamp` is derived from `UsageSnapshot::captured_at` (RFC3339)
//! parsed to unix seconds; the full snapshot is stored as a JSON blob.

use anyhow::{Context, Result};
use rusqlite::Connection;

use crate::types::usage::UsageSnapshot;

/// Parses an RFC3339 timestamp string into unix seconds.
pub(crate) fn rfc3339_to_unix(s: &str) -> Result<i64> {
    Ok(chrono::DateTime::parse_from_rfc3339(s)
        .with_context(|| format!("invalid RFC3339 timestamp: {s:?}"))?
        .timestamp())
}

/// Inserts one snapshot. The `timestamp` column comes from `captured_at`.
pub fn insert_snapshot(conn: &Connection, snapshot: &UsageSnapshot) -> Result<()> {
    let ts = rfc3339_to_unix(&snapshot.captured_at)?;
    let data = serde_json::to_string(snapshot)?;
    conn.execute(
        "INSERT INTO usage_snapshots (timestamp, data) VALUES (?1, ?2)",
        rusqlite::params![ts, data],
    )?;
    Ok(())
}

/// Returns snapshots with `timestamp >= since` (unix seconds), newest first,
/// capped at `limit`. Pass `limit = -1` for no cap.
pub fn get_snapshots(conn: &Connection, since: i64, limit: i64) -> Result<Vec<UsageSnapshot>> {
    let mut stmt = conn.prepare(
        "SELECT data FROM usage_snapshots WHERE timestamp >= ?1 ORDER BY timestamp DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(rusqlite::params![since, limit], |row| {
        let data: String = row.get(0)?;
        Ok(data)
    })?;
    let mut out = Vec::new();
    for data in rows {
        out.push(serde_json::from_str::<UsageSnapshot>(&data?)?);
    }
    Ok(out)
}

/// Returns every snapshot in ascending timestamp order.
pub fn get_all_snapshots(conn: &Connection) -> Result<Vec<UsageSnapshot>> {
    let mut stmt =
        conn.prepare("SELECT data FROM usage_snapshots ORDER BY timestamp ASC")?;
    let rows = stmt.query_map([], |row| {
        let data: String = row.get(0)?;
        Ok(data)
    })?;
    let mut out = Vec::new();
    for data in rows {
        out.push(serde_json::from_str::<UsageSnapshot>(&data?)?);
    }
    Ok(out)
}
