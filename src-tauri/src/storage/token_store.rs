//! CRUD for the `token_records` table.
//!
//! The index `timestamp` is derived from `TokenRecord::recorded_at` (RFC3339)
//! parsed to unix seconds; the full record is stored as a JSON blob.

use anyhow::Result;
use rusqlite::Connection;

use super::usage_store::rfc3339_to_unix;
use crate::tokens::record::TokenRecord;

/// Inserts one token record. The `timestamp` column comes from `recorded_at`.
pub fn insert_token_record(conn: &Connection, record: &TokenRecord) -> Result<()> {
    let ts = rfc3339_to_unix(&record.recorded_at)?;
    let data = serde_json::to_string(record)?;
    conn.execute(
        "INSERT INTO token_records (timestamp, data) VALUES (?1, ?2)",
        rusqlite::params![ts, data],
    )?;
    Ok(())
}

/// Returns token records with `timestamp >= since` (unix seconds), newest first.
pub fn get_token_records(conn: &Connection, since: i64) -> Result<Vec<TokenRecord>> {
    let mut stmt = conn.prepare(
        "SELECT data FROM token_records WHERE timestamp >= ?1 ORDER BY timestamp DESC",
    )?;
    let rows = stmt.query_map(rusqlite::params![since], |row| {
        let data: String = row.get(0)?;
        Ok(data)
    })?;
    let mut out = Vec::new();
    for data in rows {
        out.push(serde_json::from_str::<TokenRecord>(&data?)?);
    }
    Ok(out)
}
