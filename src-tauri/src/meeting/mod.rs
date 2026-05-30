//! Meeting detection: polls Windows for camera/mic use and meeting-app audio.
//! When a meeting is active and the `pauseInMeeting` setting is on (default),
//! `notifications::rules::fire` suppresses sound/voice pings and the tray
//! tooltip shows a "notifications paused" line.
//!
//! Ported from tauri_kit_meeting, slimmed to a single `meeting_active` flag
//! stored on `AppState` (no separate plugin / query command).

pub mod signal;
#[cfg(windows)]
mod windows_source;

pub use signal::{compute_in_meeting, SignalSource, Sources};

use crate::state::AppState;
use serde::Serialize;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// How often the watcher samples the OS signals.
const POLL_INTERVAL: Duration = Duration::from_secs(3);

/// Built-in meeting-app process names, matched against active audio sessions.
pub fn default_meeting_apps() -> Vec<String> {
    [
        "Teams.exe",
        "ms-teams.exe",
        "Zoom.exe",
        "CptHost.exe",
        "Discord.exe",
        "slack.exe",
        "Webex.exe",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// Payload emitted on `meeting://changed` (transitions only).
#[derive(Clone, Copy, Debug, Serialize)]
pub struct MeetingState {
    pub active: bool,
    pub sources: Sources,
}

/// Spawn the background meeting watcher. Polls every 3s; on each active/inactive
/// transition it updates `AppState.meeting_active`, emits `meeting://changed`
/// (so the tray tooltip re-renders), and logs the edge. On non-Windows the
/// signal source always reports false, so `meeting_active` stays off.
pub fn start(app: AppHandle) {
    #[cfg(windows)]
    let source: Box<dyn SignalSource> = Box::new(windows_source::WindowsSignalSource);
    #[cfg(not(windows))]
    let source: Box<dyn SignalSource> = Box::new(NoopSource);
    let apps = default_meeting_apps();

    std::thread::spawn(move || {
        let mut last: Option<bool> = None;
        loop {
            let sources = Sources {
                camera: source.camera_in_use(),
                mic: source.mic_in_use(),
                audio: source.meeting_app_audio_active(&apps),
            };
            let active = compute_in_meeting(sources);

            if let Some(state) = app.try_state::<AppState>() {
                state.meeting_active.store(active, Ordering::Relaxed);
            }

            if last != Some(active) {
                last = Some(active);
                let _ = app.emit("meeting://changed", MeetingState { active, sources });
                log::info!("meeting: active={active} sources={sources:?}");
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    });
}

#[cfg(not(windows))]
struct NoopSource;
#[cfg(not(windows))]
impl SignalSource for NoopSource {
    fn camera_in_use(&self) -> bool {
        false
    }
    fn mic_in_use(&self) -> bool {
        false
    }
    fn meeting_app_audio_active(&self, _allow: &[String]) -> bool {
        false
    }
}
