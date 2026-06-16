//! Per-dataset retention policies and the prune routine.
//!
//! Each table holds a unix-second `timestamp` column, so pruning is the same
//! `DELETE FROM <table> WHERE timestamp < ?` for all three. `KeepForever`
//! datasets are skipped entirely.

use anyhow::Result;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// How long a dataset's rows are kept before pruning.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
#[serde(rename_all = "snake_case")]
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
