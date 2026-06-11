//! App-specific audio playback built on the reusable `tauri_kit_audio` crate.
//!
//! The kit owns device enumeration, the `OutputStream` controller (open /
//! hot-swap / recovery), decode+play helpers, and the follow-OS-default
//! watcher. This module keeps only the *app* policy: a notification playback
//! queue (200 ms gap so back-to-back pings don't overlap) and a single-file
//! preview player that emits a Tauri completion event for the character view.
//!
//! Muting and meeting-pause are enforced upstream in `notifications::rules`,
//! before any function here is called, so the queue stays unconditional.

use rodio::Sink;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use tauri_kit_audio::{load_source, play_blocking, try_recover_handle, SharedHandle};

// Re-export the kit primitives the rest of the app refers to via this module,
// so call sites (`state.rs`, `ipc::audio`) don't need to know they moved.
pub use tauri_kit_audio::{list_audio_output_devices, AudioOutputDevice, AudioStreamCtrl};

const GAP: Duration = Duration::from_millis(200);

// ── Notification playback queue ───────────────────────────────────────────────

pub struct AudioCtx {
    queue: Arc<Mutex<VecDeque<PathBuf>>>,
    worker_started: Arc<Mutex<bool>>,
    handle: SharedHandle,
}

impl AudioCtx {
    pub fn new(handle: SharedHandle) -> Self {
        Self {
            queue: Arc::new(Mutex::new(VecDeque::new())),
            worker_started: Arc::new(Mutex::new(false)),
            handle,
        }
    }

    pub fn play_file(&self, path: impl AsRef<Path>) {
        if self.handle.lock().unwrap().is_none() { return; }
        self.queue.lock().unwrap().push_back(path.as_ref().to_path_buf());
        self.ensure_worker();
    }

    fn ensure_worker(&self) {
        let mut started = self.worker_started.lock().unwrap();
        if *started { return; }
        *started = true;
        let queue = Arc::clone(&self.queue);
        let flag = Arc::clone(&self.worker_started);
        let handle_shared = Arc::clone(&self.handle);
        std::thread::spawn(move || {
            loop {
                let next = queue.lock().unwrap().pop_front();
                match next {
                    Some(path) => {
                        let h = handle_shared.lock().unwrap().clone();
                        if let Some(h) = h {
                            if let Err(e) = play_blocking(&h, &path) {
                                log::warn!("audio play failed: {e}");
                                try_recover_handle(&handle_shared);
                                // Retry once with recovered handle.
                                let h2 = handle_shared.lock().unwrap().clone();
                                if let Some(h2) = h2 {
                                    if let Err(e2) = play_blocking(&h2, &path) {
                                        log::warn!("audio play retry failed: {e2}");
                                    }
                                }
                            }
                        }
                        std::thread::sleep(GAP);
                    }
                    None => {
                        std::thread::sleep(Duration::from_millis(100));
                        if queue.lock().unwrap().is_empty() {
                            *flag.lock().unwrap() = false;
                            break;
                        }
                    }
                }
            }
        });
    }
}

impl Default for AudioCtx {
    fn default() -> Self { Self::new(Arc::new(Mutex::new(None))) }
}

// ── Preview player ────────────────────────────────────────────────────────────
// Dedicated single-file preview with stop support and a completion event.
// Used by the character-detail view instead of HTML5 Audio (WebView2 blocks
// data:audio/* URIs).

enum PreviewMsg {
    Play(PathBuf, AppHandle),
    Stop,
}

pub struct PreviewCtx {
    tx: mpsc::SyncSender<PreviewMsg>,
}

impl PreviewCtx {
    pub fn new(handle: SharedHandle) -> Self {
        let (tx, rx) = mpsc::sync_channel::<PreviewMsg>(4);
        std::thread::spawn(move || {
            let mut active: Option<(Sink, AppHandle)> = None;
            loop {
                match rx.try_recv() {
                    Ok(PreviewMsg::Play(path, app)) => {
                        if let Some((s, _)) = active.take() { s.stop(); }
                        let h = handle.lock().unwrap().clone();
                        if let Some(h) = h {
                            match Sink::try_new(&h) {
                                Ok(sink) => match load_source(&path) {
                                    Ok(src) => {
                                        sink.append(src);
                                        active = Some((sink, app));
                                    }
                                    Err(e) => log::warn!("preview decode failed: {e}"),
                                },
                                Err(e) => {
                                    log::warn!("preview sink create failed: {e}");
                                    try_recover_handle(&handle);
                                }
                            }
                        }
                    }
                    Ok(PreviewMsg::Stop) => {
                        if let Some((s, _)) = active.take() { s.stop(); }
                    }
                    Err(mpsc::TryRecvError::Empty) => {}
                    Err(mpsc::TryRecvError::Disconnected) => break,
                }
                if let Some((ref sink, ref app)) = active {
                    if sink.empty() {
                        let _ = app.emit("character-preview-ended", ());
                        active = None;
                    }
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        });
        Self { tx }
    }

    pub fn play(&self, path: PathBuf, app: AppHandle) {
        let _ = self.tx.try_send(PreviewMsg::Play(path, app));
    }

    pub fn stop(&self) {
        let _ = self.tx.try_send(PreviewMsg::Stop);
    }
}

impl Default for PreviewCtx { fn default() -> Self { Self::new(Arc::new(Mutex::new(None))) } }

// ── Shared playback entry points ──────────────────────────────────────────────

/// Shared entry point: enqueue a resolved absolute path for playback.
fn play_file_internal(app: &AppHandle, path: &Path) {
    use tauri::Manager;
    app.state::<crate::state::AppState>().audio.play_file(path);
}

/// Resolve `sounds_dir()/name` -> absolute path, skipping if not found.
pub fn play_sound_file(app: &AppHandle, filename: &str) {
    let Ok(dir) = crate::settings::paths::sounds_dir() else { return; };
    let path = dir.join(filename);
    if !path.exists() {
        log::warn!("sound file missing: {path:?}");
        return;
    }
    play_file_internal(app, &path);
}

/// Play a sound file at an absolute or already-resolved path. Falls back
/// silently if the file is missing.
pub fn play_path(app: &AppHandle, path: &Path) {
    if !path.exists() {
        log::warn!("play_path: missing file {path:?}");
        return;
    }
    play_file_internal(app, path);
}

pub fn play_wav(app: &AppHandle, path: &Path) {
    play_file_internal(app, path);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_ctx_skips_play_when_handle_is_none() {
        // No panic when handle is None and play_file is called.
        let ctx = AudioCtx::default();
        ctx.play_file(std::path::Path::new("/nonexistent/path.mp3"));
        // Worker was not started because handle was None.
        assert!(!*ctx.worker_started.lock().unwrap());
    }
}
