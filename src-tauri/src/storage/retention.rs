//! Per-dataset retention policies and the prune routine.
//!
//! Each table holds a unix-second `timestamp` column, so pruning is the same
//! `DELETE FROM <table> WHERE timestamp < ?` for all three. `KeepForever`
//! datasets are skipped entirely.

use anyhow::Result;
use rusqlite::Connection;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use ts_rs::TS;

/// How long a dataset's rows are kept before pruning.
///
/// Serializes to a compact frontend-friendly string token so the settings JSON
/// and the dropdown share one shape: `"forever"` for [`RetentionPolicy::KeepForever`]
/// and `"<days>d"` (e.g. `"90d"`, `"7d"`) for [`RetentionPolicy::KeepDays`]. The
/// UI presets map Never -> `"forever"` and 1 year / 90 / 30 / 7 days ->
/// `"365d" | "90d" | "30d" | "7d"`. ts-rs sees the type as a plain `string`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts", type = "string")]
pub enum RetentionPolicy {
    /// Never prune.
    KeepForever,
    /// Keep only rows newer than `days` (e.g. 7 | 30 | 90 | 365).
    KeepDays(u32),
}

impl RetentionPolicy {
    /// The cutoff unix-second timestamp for this policy given `now`, or `None`
    /// for [`RetentionPolicy::KeepForever`] (nothing to prune).
    pub fn cutoff(&self, now: i64) -> Option<i64> {
        match self {
            RetentionPolicy::KeepForever => None,
            RetentionPolicy::KeepDays(days) => Some(now - (*days as i64) * 86_400),
        }
    }

    /// The compact string token used in settings JSON / on the wire.
    fn as_token(&self) -> String {
        match self {
            RetentionPolicy::KeepForever => "forever".to_string(),
            RetentionPolicy::KeepDays(days) => format!("{days}d"),
        }
    }

    /// Parses the compact string token back into a policy.
    fn from_token(s: &str) -> Result<Self, String> {
        if s == "forever" {
            return Ok(RetentionPolicy::KeepForever);
        }
        if let Some(num) = s.strip_suffix('d') {
            if let Ok(days) = num.parse::<u32>() {
                return Ok(RetentionPolicy::KeepDays(days));
            }
        }
        Err(format!("invalid retention policy token: {s:?}"))
    }
}

impl Serialize for RetentionPolicy {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.as_token())
    }
}

impl<'de> Deserialize<'de> for RetentionPolicy {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let raw = String::deserialize(d)?;
        RetentionPolicy::from_token(&raw).map_err(D::Error::custom)
    }
}

/// The three datasets, keyed by their table name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum Dataset {
    UsageSnapshots,
    TokenRecords,
    SkillEvents,
}

impl Dataset {
    /// SQL table name backing this dataset.
    pub fn table(&self) -> &'static str {
        match self {
            Dataset::UsageSnapshots => "usage_snapshots",
            Dataset::TokenRecords => "token_records",
            Dataset::SkillEvents => "skill_events",
        }
    }

    /// All datasets, for iteration.
    pub fn all() -> [Dataset; 3] {
        [
            Dataset::UsageSnapshots,
            Dataset::TokenRecords,
            Dataset::SkillEvents,
        ]
    }
}

/// The active retention policy for every dataset.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct RetentionPolicies {
    pub usage_snapshots: RetentionPolicy,
    pub token_records: RetentionPolicy,
    pub skill_events: RetentionPolicy,
}

impl Default for RetentionPolicies {
    /// Mirrors the legacy behavior: usage + token history pruned at 90 days,
    /// skill events kept forever (small, high analytical value).
    fn default() -> Self {
        Self {
            usage_snapshots: RetentionPolicy::KeepDays(90),
            token_records: RetentionPolicy::KeepDays(90),
            skill_events: RetentionPolicy::KeepForever,
        }
    }
}

impl RetentionPolicies {
    /// `(dataset, policy)` pairs for iteration during pruning.
    pub fn iter(&self) -> [(Dataset, RetentionPolicy); 3] {
        [
            (Dataset::UsageSnapshots, self.usage_snapshots),
            (Dataset::TokenRecords, self.token_records),
            (Dataset::SkillEvents, self.skill_events),
        ]
    }

    /// The policy for one dataset.
    pub fn policy_for(&self, dataset: Dataset) -> RetentionPolicy {
        match dataset {
            Dataset::UsageSnapshots => self.usage_snapshots,
            Dataset::TokenRecords => self.token_records,
            Dataset::SkillEvents => self.skill_events,
        }
    }
}

fn now_unix() -> i64 {
    chrono::Utc::now().timestamp()
}

/// Prunes every dataset per its policy. Returns the total number of rows
/// deleted across all tables.
pub fn prune_all(conn: &Connection, policies: &RetentionPolicies) -> Result<usize> {
    let now = now_unix();
    let mut deleted = 0usize;
    for (dataset, policy) in policies.iter() {
        if let Some(cutoff) = policy.cutoff(now) {
            let sql = format!("DELETE FROM {} WHERE timestamp < ?1", dataset.table());
            deleted += conn.execute(&sql, [cutoff])?;
        }
    }
    Ok(deleted)
}

/// Prunes a single dataset per `policy`. Returns rows deleted (0 for
/// [`RetentionPolicy::KeepForever`]).
pub fn prune_one(conn: &Connection, dataset: Dataset, policy: RetentionPolicy) -> Result<usize> {
    let Some(cutoff) = policy.cutoff(now_unix()) else {
        return Ok(0);
    };
    let sql = format!("DELETE FROM {} WHERE timestamp < ?1", dataset.table());
    Ok(conn.execute(&sql, [cutoff])?)
}

/// Row count, plus oldest/newest unix-second timestamps for a dataset. The
/// timestamps are `None` when the table is empty.
pub struct DatasetStats {
    pub record_count: u64,
    pub oldest_entry: Option<i64>,
    pub newest_entry: Option<i64>,
}

/// Reads `(count, min(timestamp), max(timestamp))` for one dataset in a single
/// query. `MIN`/`MAX` over an empty table return SQL NULL, surfaced as `None`.
pub fn dataset_stats(conn: &Connection, dataset: Dataset) -> Result<DatasetStats> {
    let sql = format!(
        "SELECT COUNT(*), MIN(timestamp), MAX(timestamp) FROM {}",
        dataset.table()
    );
    let stats = conn.query_row(&sql, [], |row| {
        Ok(DatasetStats {
            record_count: row.get::<_, i64>(0)? as u64,
            oldest_entry: row.get::<_, Option<i64>>(1)?,
            newest_entry: row.get::<_, Option<i64>>(2)?,
        })
    })?;
    Ok(stats)
}

/// Deletes every row from a dataset and reclaims the freed pages via `VACUUM`.
/// Used by the "Clear all" control. `VACUUM` cannot run inside a transaction,
/// so it executes as its own statement after the delete commits.
pub fn clear_dataset(conn: &Connection, dataset: Dataset) -> Result<()> {
    conn.execute(&format!("DELETE FROM {}", dataset.table()), [])?;
    conn.execute_batch("VACUUM")?;
    Ok(())
}
