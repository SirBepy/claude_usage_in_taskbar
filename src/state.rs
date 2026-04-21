//! Runtime app state shared across Tauri commands and background tasks.

use crate::display_state::TrayDisplayState;
use crate::types::{AuthState, Settings, UsageSnapshot};
use std::sync::Mutex;

pub struct AppState {
    pub current_usage: Mutex<Option<UsageSnapshot>>,
    pub settings: Mutex<Settings>,
    pub auth_state: Mutex<AuthState>,
    pub display: Mutex<TrayDisplayState>,
    pub audio: crate::audio::AudioCtx,
}

impl AppState {
    pub fn new(settings: Settings, auth_state: AuthState) -> Self {
        Self {
            current_usage: Mutex::new(None),
            settings: Mutex::new(settings),
            auth_state: Mutex::new(auth_state),
            display: Mutex::new(TrayDisplayState::default()),
            audio: crate::audio::AudioCtx::new(),
        }
    }
}
