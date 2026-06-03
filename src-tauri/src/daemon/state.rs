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
    /// Reliable-delivery store for prompts the app must surface (question cards).
    /// The lossy `notifier` broadcast can silently drop a frame under pipe
    /// backpressure, which left AskUserQuestion turns hung forever. Instead the
    /// daemon records each open prompt here (keyed by request id) and the app
    /// POLLS `list_pending_prompts` over the reliable RPC channel. Each value is
    /// `{ "id", "event", "payload" }` - `event` is the Tauri event the app emits,
    /// `payload` is its body. Inserted when the prompt opens, removed when it is
    /// answered or times out.
    pub pending_prompts: Arc<Mutex<HashMap<String, Value>>>,
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
            pending_prompts: Arc::new(Mutex::new(HashMap::new())),
            shutdown: Arc::new(Notify::new()),
        })
    }

    /// Record an open prompt for reliable poll-based delivery to the app.
    /// `event` is the Tauri event name the app should emit (e.g.
    /// `"question-requested"`); `payload` is its body.
    pub async fn add_prompt(&self, id: &str, event: &str, payload: Value) {
        self.pending_prompts.lock().await.insert(
            id.to_string(),
            serde_json::json!({ "id": id, "event": event, "payload": payload }),
        );
    }

    /// Drop an open prompt once it has been answered or timed out.
    pub async fn remove_prompt(&self, id: &str) {
        self.pending_prompts.lock().await.remove(id);
    }

    /// Snapshot of all open prompts, for the app's `list_pending_prompts` poll.
    pub async fn list_prompts(&self) -> Vec<Value> {
        self.pending_prompts.lock().await.values().cloned().collect()
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
