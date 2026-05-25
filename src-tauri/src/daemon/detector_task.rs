//! Daemon-side detector reconcile task. Every 5s walks live PIDs and marks
//! ended instances; also refreshes session titles from `/close`-written
//! rename overrides. Publishes `instances_changed` on every mutation.

use crate::daemon::state::DaemonState;
use crate::sessions::registry::Registry;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

pub fn spawn(state: Arc<DaemonState>) {
    let registry = state.registry.clone();
    let notifier = state.notifier.clone();
    // Task-local (no mutex) cache of each session's last-seen transcript mtime,
    // so we only re-read the file when it actually grew.
    let mut mtimes: HashMap<String, SystemTime> = HashMap::new();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(5));
        loop {
            ticker.tick().await;
            let ended = crate::sessions::detector::reconcile_once(&registry);

            // Build (session_id, transcript_path) for every still-live session.
            // `reconcile_once` deliberately skips Interactive sessions, so this
            // is a separate pass that owns override-driven renames.
            let live: Vec<(String, PathBuf)> = registry
                .list()
                .into_iter()
                .filter(|i| i.ended_at.is_none())
                .filter_map(|i| {
                    crate::tokens::transcript_for_session(&i.cwd, &i.session_id)
                        .map(|p| (i.session_id, p))
                })
                .collect();
            let renamed = refresh_overrides(&registry, &live, &mut mtimes);

            if ended || renamed {
                notifier.publish("instances_changed", json!({"instances": registry.list()}));
            }
        }
    });
}

/// For each live session whose transcript mtime advanced since the last tick,
/// tail-reads the latest `/close` rename override and applies it via
/// `set_name`. Only overrides drive a rename here — the first user prompt is
/// already set at registration, so this never does a full-file scan. Prunes
/// the mtime cache to the sessions still passed in. Returns true if any name
/// actually changed.
fn refresh_overrides(
    registry: &Registry,
    live: &[(String, PathBuf)],
    mtimes: &mut HashMap<String, SystemTime>,
) -> bool {
    let mut changed = false;
    for (session_id, path) in live {
        let Ok(mtime) = std::fs::metadata(path).and_then(|m| m.modified()) else { continue };
        if mtimes.get(session_id) == Some(&mtime) { continue; }
        mtimes.insert(session_id.clone(), mtime);
        if let Some(title) = crate::tokens::last_override_title(path, 60) {
            if registry.set_name(session_id, title) {
                changed = true;
            }
        }
    }
    let live_ids: HashSet<&str> = live.iter().map(|(id, _)| id.as_str()).collect();
    mtimes.retain(|k, _| live_ids.contains(k.as_str()));
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn override_jsonl(value: &str) -> String {
        serde_json::json!({"type":"custom-title","customTitle":value,"sessionId":"s1"}).to_string()
    }

    #[test]
    fn override_refresh_renames_live_session() {
        let reg = Registry::new();
        reg.upsert_interactive("s1", std::path::Path::new("/tmp/x"), "proj", "2026-05-22T00:00:00Z");
        let dir = tempdir().unwrap();
        let path = dir.path().join("s1.jsonl");
        std::fs::write(&path, override_jsonl("Renamed Live")).unwrap();
        let mut mtimes = HashMap::new();

        let changed = refresh_overrides(&reg, &[("s1".into(), path)], &mut mtimes);
        assert!(changed);
        assert_eq!(reg.get("s1").unwrap().name.as_deref(), Some("Renamed Live"));
    }

    #[test]
    fn override_refresh_noops_when_mtime_unchanged() {
        let reg = Registry::new();
        reg.upsert_interactive("s1", std::path::Path::new("/tmp/x"), "proj", "2026-05-22T00:00:00Z");
        let dir = tempdir().unwrap();
        let path = dir.path().join("s1.jsonl");
        std::fs::write(&path, override_jsonl("First")).unwrap();
        let mut mtimes = HashMap::new();
        let live = [("s1".to_string(), path.clone())];

        assert!(refresh_overrides(&reg, &live, &mut mtimes));
        // Second pass without touching the file: mtime unchanged, no work.
        assert!(!refresh_overrides(&reg, &live, &mut mtimes));
    }

    #[test]
    fn mtime_cache_pruned_for_dropped_sessions() {
        let reg = Registry::new();
        reg.upsert_interactive("s1", std::path::Path::new("/tmp/x"), "proj", "2026-05-22T00:00:00Z");
        let dir = tempdir().unwrap();
        let path = dir.path().join("s1.jsonl");
        std::fs::write(&path, override_jsonl("Name")).unwrap();
        let mut mtimes = HashMap::new();

        refresh_overrides(&reg, &[("s1".into(), path)], &mut mtimes);
        assert!(mtimes.contains_key("s1"));
        // s1 no longer live → its cache entry is pruned.
        refresh_overrides(&reg, &[], &mut mtimes);
        assert!(!mtimes.contains_key("s1"));
    }
}
