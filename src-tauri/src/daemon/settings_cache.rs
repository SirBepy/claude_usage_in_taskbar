//! Daemon-side Settings cache. The app process is authoritative for
//! `settings.json` on disk; the daemon holds an in-memory snapshot used by
//! the hook server for project_id resolution. App pushes the snapshot via
//! the `set_settings` RPC at handshake time and on every change.

use crate::settings;
use crate::types::Settings;
use std::path::Path;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct SettingsCache {
    inner: Arc<Mutex<Settings>>,
}

impl SettingsCache {
    pub fn new(initial: Settings) -> Self {
        Self { inner: Arc::new(Mutex::new(initial)) }
    }

    pub fn replace(&self, new: Settings) {
        let mut g = self.inner.lock().unwrap();
        *g = new;
    }

    pub fn snapshot(&self) -> Settings {
        self.inner.lock().unwrap().clone()
    }

    /// Mirror of `settings::upsert_project_for_cwd` but operating on the cache.
    /// Returns `(project_id, created_new)`. When `created_new` is true, the
    /// caller should emit a `project_created` notification so the app process
    /// can persist the matching mutation to `settings.json`.
    pub fn upsert_project_for_cwd(&self, cwd: &Path, now: &str) -> (String, bool) {
        let mut g = self.inner.lock().unwrap();
        settings::upsert_project_for_cwd(&mut g, cwd, now)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Settings;
    use std::path::PathBuf;

    #[test]
    fn upsert_new_cwd_creates_project() {
        let cache = SettingsCache::new(Settings::default());
        let (id1, created) = cache.upsert_project_for_cwd(&PathBuf::from("/tmp/p1"), "2026-05-20T00:00:00Z");
        assert!(created);
        assert!(!id1.is_empty());
    }

    #[test]
    fn upsert_existing_cwd_returns_same_id() {
        let cache = SettingsCache::new(Settings::default());
        let (id1, c1) = cache.upsert_project_for_cwd(&PathBuf::from("/tmp/p2"), "2026-05-20T00:00:00Z");
        let (id2, c2) = cache.upsert_project_for_cwd(&PathBuf::from("/tmp/p2"), "2026-05-20T00:00:01Z");
        assert!(c1);
        assert!(!c2);
        assert_eq!(id1, id2);
    }

    #[test]
    fn replace_swaps_snapshot() {
        let cache = SettingsCache::new(Settings::default());
        let mut s2 = Settings::default();
        s2.hook_port = Some(65000);
        cache.replace(s2.clone());
        assert_eq!(cache.snapshot().hook_port, Some(65000));
    }
}
