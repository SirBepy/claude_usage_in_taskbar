//! Runtime app state shared across Tauri commands and background tasks.

use crate::channels::Manager as ChannelsManager;
use crate::tray::TrayDisplayState;
use crate::hooks::Registry;
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
    pub instances: Arc<Registry>,
    pub channels: Arc<ChannelsManager>,
    pub hook_registration_pending: Mutex<bool>,
    pub update_state: Mutex<serde_json::Value>,
    pub should_quit: Arc<AtomicBool>,
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
            instances: Arc::new(Registry::new()),
            channels: Arc::new(ChannelsManager::new()),
            hook_registration_pending: Mutex::new(false),
            update_state: Mutex::new(serde_json::json!({ "state": "idle" })),
            should_quit: Arc::new(AtomicBool::new(false)),
        }
    }
}
