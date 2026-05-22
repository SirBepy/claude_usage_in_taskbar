//! Persistence for Interactive (Path C) sessions.
//!
//! The in-memory `Registry` is rebuilt on every app start. External /
//! Automated entries get rehydrated from `~/.claude/sessions/*.json` (the
//! live-pid files Claude writes). Interactive entries have NO live process
//! between turns, so they'd vanish on app close without a separate store.
//!
//! This module owns that store: a single JSON file at
//! `<app-data>/interactive-sessions.json` containing one record per
//! resumable Interactive session. Written atomically (tmp + rename) after
//! every Interactive-mutating IPC call. Read once on app startup and
//! merged into the registry via `upsert_interactive`.
//!
//! Eviction policy: entries marked ended (via `clear_session`) are excluded
//! from the snapshot, so they disappear on the next save. On load, entries
//! whose cwd no longer exists are skipped (project deleted) - the file
//! self-cleans the next time we save.

use crate::sessions::kinds::InstanceKind;
use crate::sessions::registry::Registry;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PersistedInteractive {
    pub session_id: String,
    pub cwd: PathBuf,
    pub project_id: String,
    pub name: Option<String>,
    pub model: String,
    pub effort: String,
    pub started_at: String,
}

/// Best-effort write of every live Interactive entry to `path`. Failures
/// are logged, never propagated: a chat turn must not crash because the
/// snapshot file is read-only or full.
pub fn save_snapshot(registry: &Registry, path: &Path) {
    let snapshot: Vec<PersistedInteractive> = registry
        .list()
        .into_iter()
        .filter(|i| matches!(i.kind, InstanceKind::Interactive) && i.ended_at.is_none())
        // `name` here is the resolved title (curated override or first prompt);
        // re-persisting it means disk converges to a /close rename on the next
        // save. The jsonl override stays the source of truth — this snapshot is
        // just a cache so a session shows its name before its transcript is
        // re-resolved on restore.
        .map(|i| PersistedInteractive {
            session_id: i.session_id,
            cwd: i.cwd,
            project_id: i.project_id,
            name: i.name,
            model: i.model,
            effort: i.effort,
            started_at: i.started_at,
        })
        .collect();
    let json = match serde_json::to_string_pretty(&snapshot) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("persist sessions: serialize failed: {e}");
            return;
        }
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let tmp = path.with_extension("json.tmp");
    if let Err(e) = fs::write(&tmp, json) {
        log::warn!("persist sessions: write tmp failed: {e}");
        return;
    }
    if let Err(e) = fs::rename(&tmp, path) {
        log::warn!("persist sessions: rename failed: {e}");
        let _ = fs::remove_file(&tmp);
    }
}

/// Convenience wrapper: resolve the default snapshot path and call
/// [`save_snapshot`]. Used by IPC handlers that mutate Interactive state.
pub fn save_snapshot_default(registry: &Registry) {
    let path = match crate::settings::paths::interactive_sessions_file() {
        Ok(p) => p,
        Err(e) => {
            log::warn!("persist sessions: path: {e}");
            return;
        }
    };
    save_snapshot(registry, &path);
}

pub fn load_snapshot(path: &Path) -> Vec<PersistedInteractive> {
    let raw = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    match serde_json::from_str::<Vec<PersistedInteractive>>(&raw) {
        Ok(v) => v,
        Err(e) => {
            // Preserve the corrupt file for diagnosis instead of letting the next
            // save_snapshot silently clobber it (mirrors settings::store::load).
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let backup = path.with_extension(format!("json.broken-{ts}"));
            let _ = fs::rename(path, &backup);
            log::warn!("persist sessions: parse failed ({e}); preserved at {} and loaded none", backup.display());
            Vec::new()
        }
    }
}

/// Replay a loaded snapshot into the registry. Entries whose cwd is gone
/// from disk are skipped (project deleted off the machine - resuming would
/// fail anyway). All others are upserted as inactive Interactive entries
/// with `busy: false`.
pub fn populate_registry(registry: &Registry, sessions: Vec<PersistedInteractive>) -> usize {
    let mut added = 0usize;
    for s in sessions {
        if !s.cwd.exists() {
            continue;
        }
        registry.upsert_interactive(&s.session_id, &s.cwd, &s.project_id, &s.started_at);
        if !s.model.is_empty() || !s.effort.is_empty() {
            registry.set_model_effort(&s.session_id, &s.model, &s.effort);
        }
        // A /close rename written since the last save lives in the transcript,
        // so a fresh override beats the persisted snapshot name; the snapshot is
        // the next fallback; only if neither exists do we derive from the first
        // prompt. This is what makes a rename survive an app restart.
        let tpath = crate::tokens::transcript_for_session(&s.cwd, &s.session_id);
        let resolved_name = tpath
            .as_deref()
            .and_then(|p| crate::tokens::last_override_title(p, 60))
            .or(s.name)
            .or_else(|| tpath.as_deref().and_then(|p| crate::tokens::first_user_prompt(p, 60)));
        if let Some(name) = resolved_name {
            registry.set_name(&s.session_id, name);
        }
        added += 1;
    }
    added
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn save_then_load_roundtrip() {
        let registry = Registry::new();
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path().to_path_buf();
        let path = tmp.path().join("snap.json");

        registry.upsert_interactive("sess-1", &cwd, "proj-x", "2026-05-13T00:00:00Z");
        registry.set_model_effort("sess-1", "opus", "high");
        registry.set_name("sess-1", "First chat".into());

        save_snapshot(&registry, &path);
        let loaded = load_snapshot(&path);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].session_id, "sess-1");
        assert_eq!(loaded[0].model, "opus");
        assert_eq!(loaded[0].effort, "high");
        assert_eq!(loaded[0].name.as_deref(), Some("First chat"));
    }

    #[test]
    fn populate_skips_missing_cwd() {
        let registry = Registry::new();
        let sessions = vec![PersistedInteractive {
            session_id: "ghost".into(),
            cwd: PathBuf::from("/definitely/does/not/exist/abc123"),
            project_id: "p".into(),
            name: None,
            model: String::new(),
            effort: String::new(),
            started_at: "2026-05-13T00:00:00Z".into(),
        }];
        let added = populate_registry(&registry, sessions);
        assert_eq!(added, 0);
        assert!(registry.get("ghost").is_none());
    }

    #[test]
    fn save_excludes_ended_entries() {
        let registry = Registry::new();
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path().to_path_buf();
        let path = tmp.path().join("snap.json");

        registry.upsert_interactive("live", &cwd, "p", "2026-05-13T00:00:00Z");
        registry.upsert_interactive("dead", &cwd, "p", "2026-05-13T00:00:00Z");
        registry.mark_ended("dead", crate::types::EndReason::Manual, "2026-05-13T01:00:00Z");

        save_snapshot(&registry, &path);
        let loaded = load_snapshot(&path);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].session_id, "live");
    }
}
