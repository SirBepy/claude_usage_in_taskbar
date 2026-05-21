//! Daemon-side shared state container. Owns the registry, session map,
//! settings cache, notifier, and pending request map. One `Arc<DaemonState>`
//! is constructed in `bin/cc_companion_daemon.rs` and injected into the hook
//! server, RPC handlers, and detector loop.

use crate::channels::manager::Manager as ChannelsManager;
use crate::daemon::notifier::Notifier;
use crate::daemon::session::SessionMap;
use crate::daemon::settings_cache::SettingsCache;
use crate::sessions::registry::Registry;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{oneshot, Mutex, Notify};

pub type PendingMap = Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>;

pub struct DaemonState {
    pub sessions: SessionMap,
    pub registry: Arc<Registry>,
    pub settings: SettingsCache,
    pub notifier: Notifier,
    pub pending: PendingMap,
    pub channels: Arc<ChannelsManager>,
    /// Signalled by the `shutdown_daemon` RPC so the main loop exits the
    /// process. `run_daemon_main` selects on `shutdown.notified()`.
    pub shutdown: Arc<Notify>,
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
            channels: Arc::new(ChannelsManager::new()),
            shutdown: Arc::new(Notify::new()),
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
        assert_eq!(st.channels.list().len(), 0);
    }
}
