//! One-time import of the legacy on-disk stores into SQLite.
//!
//! Three sources, three shapes:
//! - `history.jsonl` - JSONL, one [`UsageSnapshot`] per line.
//! - `token-history.json` - a single JSON **array** of [`TokenRecord`].
//! - `skill-usage/events-YYYY-MM-DD.jsonl` - daily JSONL files, one
//!   [`SkillUsageEvent`] per line.
//!
//! Parsing is best-effort: bad lines / files are logged and skipped so a
//! partial import beats an abort. After a source is imported it is renamed to
//! `<name>.bak` (non-destructive). The settings migration flag is the caller's
//! responsibility (wired in a later slice).

use anyhow::Result;
use rusqlite::Connection;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use super::{skill_store, token_store, usage_store};
use crate::skill_usage::types::SkillUsageEvent;
use crate::tokens::record::TokenRecord;
use crate::types::usage::UsageSnapshot;

/// Outcome of a single source import.
#[derive(Debug, Default, Clone, Copy)]
pub struct ImportStats {
    pub imported: usize,
    pub skipped: usize,
}

/// Renames `path` to `path.bak` (overwriting an existing `.bak`). Logs and
/// swallows failures - a failed rename must not undo a successful import.
fn rename_to_bak(path: &Path) {
    let bak = bak_path(path);
    if let Err(e) = std::fs::rename(path, &bak) {
        log::warn!("storage migration: could not rename {path:?} -> {bak:?}: {e}");
    }
}

/// `foo.jsonl` -> `foo.jsonl.bak` (appends, does not replace the extension).
fn bak_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".bak");
    path.with_file_name(name)
}

/// Imports a JSONL file of `UsageSnapshot` (the `history.jsonl` shape). Missing
/// file is a clean no-op. On success the source is renamed to `.bak`.
pub fn import_usage_jsonl(conn: &Connection, path: &Path) -> Result<ImportStats> {
    let mut stats = ImportStats::default();
    if !path.exists() {
        return Ok(stats);
    }
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) => {
            log::warn!("storage migration: cannot open {path:?}: {e}");
            return Ok(stats);
        }
    };
    for line in BufReader::new(file).lines() {
        let raw = match line {
            Ok(l) => l,
            Err(_) => {
                stats.skipped += 1;
                continue;
            }
        };
        if raw.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<UsageSnapshot>(&raw) {
            Ok(snap) => match usage_store::insert_snapshot(conn, &snap) {
                Ok(()) => stats.imported += 1,
                Err(e) => {
                    log::warn!("storage migration: insert usage snapshot failed: {e}");
                    stats.skipped += 1;
                }
            },
            Err(_) => stats.skipped += 1,
        }
    }
    rename_to_bak(path);
    Ok(stats)
}

/// Imports the `token-history.json` array of `TokenRecord`. Missing file is a
/// clean no-op. On success the source is renamed to `.bak`.
pub fn import_token_history_json(conn: &Connection, path: &Path) -> Result<ImportStats> {
    let mut stats = ImportStats::default();
    if !path.exists() {
        return Ok(stats);
    }
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("storage migration: cannot read {path:?}: {e}");
            return Ok(stats);
        }
    };
    let records: Vec<TokenRecord> = match serde_json::from_str(&raw) {
        Ok(r) => r,
        Err(e) => {
            log::warn!("storage migration: {path:?} is not a TokenRecord array: {e}");
            return Ok(stats);
        }
    };
    for record in &records {
        match token_store::insert_token_record(conn, record) {
            Ok(()) => stats.imported += 1,
            Err(e) => {
                log::warn!("storage migration: insert token record failed: {e}");
                stats.skipped += 1;
            }
        }
    }
    rename_to_bak(path);
    Ok(stats)
}

/// Imports every `events-*.jsonl` daily file under `dir`. Each file is JSONL of
/// `SkillUsageEvent`. Missing dir is a clean no-op. Each successfully-read file
/// is renamed to `.bak`.
pub fn import_skill_events_dir(conn: &Connection, dir: &Path) -> Result<ImportStats> {
    let mut stats = ImportStats::default();
    if !dir.exists() {
        return Ok(stats);
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => {
            log::warn!("storage migration: cannot read dir {dir:?}: {e}");
            return Ok(stats);
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if !(name.starts_with("events-") && name.ends_with(".jsonl")) {
            continue;
        }
        let file = match std::fs::File::open(&path) {
            Ok(f) => f,
            Err(e) => {
                log::warn!("storage migration: cannot open {path:?}: {e}");
                continue;
            }
        };
        for line in BufReader::new(file).lines() {
            let raw = match line {
                Ok(l) => l,
                Err(_) => {
                    stats.skipped += 1;
                    continue;
                }
            };
            if raw.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<SkillUsageEvent>(&raw) {
                Ok(event) => match skill_store::insert_skill_event(conn, &event) {
                    Ok(()) => stats.imported += 1,
                    Err(e) => {
                        log::warn!("storage migration: insert skill event failed: {e}");
                        stats.skipped += 1;
                    }
                },
                Err(_) => stats.skipped += 1,
            }
        }
        rename_to_bak(&path);
    }
    Ok(stats)
}

/// Runs all three imports against the standard data-dir paths. The caller is
/// responsible for the `storage_migrated_v1` settings gate (later slice).
pub fn import_all_default(conn: &Connection) -> Result<[ImportStats; 3]> {
    let usage = crate::settings::paths::history_file()
        .ok()
        .map(|p| import_usage_jsonl(conn, &p))
        .transpose()?
        .unwrap_or_default();
    let tokens = crate::settings::paths::token_history_file()
        .ok()
        .map(|p| import_token_history_json(conn, &p))
        .transpose()?
        .unwrap_or_default();
    let skills = crate::settings::paths::skill_usage_dir()
        .ok()
        .map(|p| import_skill_events_dir(conn, &p))
        .transpose()?
        .unwrap_or_default();
    Ok([usage, tokens, skills])
}
