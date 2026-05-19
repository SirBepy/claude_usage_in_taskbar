//! Daemon-side shared state container. Owns the registry, session map,
//! settings cache, notifier, and pending request map. One `Arc<DaemonState>`
//! is constructed in `bin/cc_companion_daemon.rs` and injected into the hook
//! server, RPC handlers, and detector loop.

use crate::daemon::notifier::Notifier;
use crate::daemon::session::SessionMap;
use crate::daemon::settings_cache::SettingsCache;
use crate::sessions::registry::Registry;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{oneshot, Mutex};

pub type PendingMap = Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>;

pub struct DaemonState {
    pub sessions: SessionMap,
    pub registry: Arc<Registry>,
    pub settings: SettingsCache,
    pub notifier: Notifier,
    pub pending: PendingMap,
}

impl DaemonState {
    pub fn new(
        sessions: SessionMap,
        settings: SettingsCache,
    ) -> Arc<Self> {
        Arc::new(Self {
            sessions,
            registry: Arc::new(Registry::new()),
            settings,
            notifier: Notifier::new(),
            pending: Arc::new(Mutex::new(HashMap::new())),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::types::Settings;

    #[tokio::test]
    async fn state_constructs_with_empty_registry_and_pending() {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        assert_eq!(st.registry.list().len(), 0);
        assert_eq!(st.pending.lock().await.len(), 0);
    }
}
