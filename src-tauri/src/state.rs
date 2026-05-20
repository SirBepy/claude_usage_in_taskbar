//! Runtime app state shared across Tauri commands and background tasks.

use crate::tray::TrayDisplayState;
use crate::types::{AuthState, Settings, UsageSnapshot};
use std::sync::{Arc, Mutex};
use std::sync::atomic::AtomicBool;

pub struct AppState {
    pub current_usage: Mutex<Option<UsageSnapshot>>,
    pub settings: Mutex<Settings>,
    pub auth_state: Mutex<AuthState>,
    pub display: Mutex<TrayDisplayState>,
    pub audio_stream: crate::notifications::audio::AudioStreamCtrl,
    pub audio: crate::notifications::audio::AudioCtx,
    pub preview: crate::notifications::audio::PreviewCtx,
    /// Daemon-owned instance list, mirrored locally. Refreshed from
    /// `instances_changed` notifications. App-side reads consult this cache;
    /// writes go through `daemon_client` (Phase 5 wires the writers).
    pub cached_instances: Arc<Mutex<Vec<crate::types::Instance>>>,
    /// Daemon-owned channel list, mirrored locally. Refreshed from
    /// `channels_changed` notifications. Replaces the app-owned `channels`
    /// Manager for read paths now that the daemon owns channel processes.
    pub cached_channels: Arc<Mutex<Vec<serde_json::Value>>>,
    /// Connected persistent client to the daemon. `None` until startup wiring
    /// in `lib.rs` connects and subscribes.
    pub daemon_client: Arc<tokio::sync::Mutex<Option<crate::daemon_client::PersistentClient>>>,
    pub hook_registration_pending: Mutex<bool>,
    pub update_state: Mutex<serde_json::Value>,
    pub should_quit: Arc<AtomicBool>,
    /// Set to true the first time the webview JS sends `frontend_ready`.
    /// Watchdog spawned in lib.rs reloads the main window if this never flips
    /// (covers WebView2 showing a "can't reach this page" error when the
    /// dev/prod start URL fails at boot, e.g. autostart racing with the network).
    pub frontend_alive: Arc<AtomicBool>,
}

impl AppState {
    pub fn new(settings: Settings, auth_state: AuthState) -> Self {
        let audio_stream = crate::notifications::audio::AudioStreamCtrl::init(
            settings.audio_output_device.as_deref(),
        );
        let audio = crate::notifications::audio::AudioCtx::new(audio_stream.handle_arc());
        let preview = crate::notifications::audio::PreviewCtx::new(audio_stream.handle_arc());
        Self {
            current_usage: Mutex::new(None),
            settings: Mutex::new(settings),
            auth_state: Mutex::new(auth_state),
            display: Mutex::new(TrayDisplayState::default()),
            audio_stream,
            audio,
            preview,
            cached_instances: Arc::new(Mutex::new(Vec::new())),
            cached_channels: Arc::new(Mutex::new(Vec::new())),
            daemon_client: Arc::new(tokio::sync::Mutex::new(None)),
            hook_registration_pending: Mutex::new(false),
            update_state: Mutex::new(serde_json::json!({ "state": "idle" })),
            should_quit: Arc::new(AtomicBool::new(false)),
            frontend_alive: Arc::new(AtomicBool::new(false)),
        }
    }
}
