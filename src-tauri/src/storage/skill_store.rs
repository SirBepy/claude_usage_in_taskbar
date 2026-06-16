//! CRUD for the `skill_events` table.
//!
//! The index `timestamp` is derived from `SkillUsageEvent::ts` (RFC3339)
//! parsed to unix seconds; the full event is stored as a JSON blob.

use anyhow::Result;
use rusqlite::Connection;

use super::usage_store::rfc3339_to_unix;
use crate::skill_usage::types::SkillUsageEvent;

/// Inserts one skill event. The `timestamp` column comes from `ts`.
pub fn insert_skill_event(conn: &Connection, event: &SkillUsageEvent) -> Result<()> {
    let ts = rfc3339_to_unix(&event.ts)?;
    let data = serde_json::to_string(event)?;
    conn.execute(
        "INSERT INTO skill_events (timestamp, data) VALUES (?1, ?2)",
        rusqlite::params![ts, data],
    )?;
    Ok(())
}

/// Returns skill events with `timestamp >= since` (unix seconds), newest first,
/// capped at `limit`. Pass `limit = -1` for no cap.
pub fn get_skill_events(conn: &Connection, since: i64, limit: i64) -> Result<Vec<SkillUsageEvent>> {
    let mut stmt = conn.prepare(
        "SELECT data FROM skill_events WHERE timestamp >= ?1 ORDER BY timestamp DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(rusqlite::params![since, limit], |row| {
        let data: String = row.get(0)?;
        Ok(data)
    })?;
    let mut out = Vec::new();
    for data in rows {
        out.push(serde_json::from_str::<SkillUsageEvent>(&data?)?);
    }
    Ok(out)
}
