//! Audio playback queue. One consumer thread, 200ms gap between entries so
//! back-to-back notifications don't overlap.
//!
//! A single `OutputStream` is held on a dedicated background thread per device.
//! Both `AudioCtx` and `PreviewCtx` share the `OutputStreamHandle` via
//! `Arc<Mutex<...>>` so a hot-swap (device change or failure recovery) is
//! visible to both without restarting the worker threads.

use anyhow::{Context, Result};
use cpal::traits::{DeviceTrait, HostTrait};
use rodio::{Decoder, OutputStream, OutputStreamHandle, Sink};
use std::collections::VecDeque;
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const GAP: Duration = Duration::from_millis(200);

// ── Device opening helpers ────────────────────────────────────────────────────

/// Open a named output device, or the OS default if `name` is None.
/// Falls back to `try_default()` if the named device is not found or fails.
fn open_device(name: Option<&str>) -> Option<(OutputStream, OutputStreamHandle)> {
    if let Some(name) = name {
        let host = cpal::default_host();
        if let Ok(mut devs) = host.output_devices() {
            if let Some(dev) = devs.find(|d| d.name().ok().as_deref() == Some(name)) {
                if let Ok(pair) = OutputStream::try_from_device(&dev) {
                    return Some(pair);
                }
                log::warn!("audio: failed to open device {name:?}, falling back to default");
            } else {
                log::warn!("audio: device {name:?} not found, falling back to default");
            }
        }
    }
    OutputStream::try_default().ok()
}

/// Spawn a background thread that keeps an `OutputStream` alive.
/// The thread blocks on `shutdown_rx` and exits (dropping the stream) when signaled.
/// Returns (handle, shutdown_tx) on success, None if the device can't be opened within 500 ms.
fn spawn_stream_thread(
    device_name: Option<String>,
) -> Option<(Arc<OutputStreamHandle>, mpsc::SyncSender<()>)> {
    let (result_tx, result_rx) = mpsc::sync_channel::<Option<OutputStreamHandle>>(1);
    let (shutdown_tx, shutdown_rx) = mpsc::sync_channel::<()>(1);

    std::thread::spawn(move || {
        match open_device(device_name.as_deref()) {
            Some((_stream, handle)) => {
                let _ = result_tx.send(Some(handle));
                let _ = shutdown_rx.recv(); // block; _stream drops when thread exits
            }
            None => {
                log::warn!("audio: failed to open output stream");
                let _ = result_tx.send(None);
            }
        }
    });

    result_rx
        .recv_timeout(Duration::from_millis(500))
        .ok()
        .flatten()
        .map(|h| (Arc::new(h), shutdown_tx))
}

// ── AudioStreamCtrl ───────────────────────────────────────────────────────────

/// Owns the lifetime of the `OutputStream` background thread and exposes a
/// shared handle reference that `AudioCtx` and `PreviewCtx` read from.
pub struct AudioStreamCtrl {
    handle: Arc<Mutex<Option<Arc<OutputStreamHandle>>>>,
    shutdown_tx: Mutex<Option<mpsc::SyncSender<()>>>,
}

impl AudioStreamCtrl {
    /// Initialize with the named device or OS default.
    pub fn init(device_name: Option<&str>) -> Self {
        let shared = Arc::new(Mutex::new(None::<Arc<OutputStreamHandle>>));
        let shutdown = Mutex::new(None::<mpsc::SyncSender<()>>);
        let ctrl = Self { handle: shared, shutdown_tx: shutdown };
        if let Some((h, tx)) = spawn_stream_thread(device_name.map(|s| s.to_string())) {
            *ctrl.handle.lock().unwrap() = Some(h);
            *ctrl.shutdown_tx.lock().unwrap() = Some(tx);
        }
        ctrl
    }

    /// Hot-swap to a different device. Signals the old thread to exit cleanly,
    /// then starts a new thread. Falls back to OS default if the device can't be opened.
    pub fn reinit(&self, device_name: Option<&str>) {
        // Signal old thread to exit (drops old OutputStream and releases WASAPI client).
        if let Some(tx) = self.shutdown_tx.lock().unwrap().take() {
            let _ = tx.send(());
        }
        match spawn_stream_thread(device_name.map(|s| s.to_string())) {
            Some((h, tx)) => {
                *self.handle.lock().unwrap() = Some(h);
                *self.shutdown_tx.lock().unwrap() = Some(tx);
            }
            None => {
                *self.handle.lock().unwrap() = None;
                log::warn!("audio: reinit failed, audio disabled until next restart");
            }
        }
    }

    /// Clone of the shared handle reference for use by `AudioCtx` / `PreviewCtx`.
    pub fn handle_arc(&self) -> Arc<Mutex<Option<Arc<OutputStreamHandle>>>> {
        Arc::clone(&self.handle)
    }
}

// ── Failure recovery ──────────────────────────────────────────────────────────

/// On Sink failure (device disappeared), try to recover by opening the OS default.
/// Swaps the shared handle on success. The old OutputStream thread (for the gone device)
/// is left dormant - Windows releases the WASAPI client when the device disconnects.
fn try_recover_handle(shared: &Arc<Mutex<Option<Arc<OutputStreamHandle>>>>) {
    let (result_tx, result_rx) = mpsc::sync_channel::<Option<OutputStreamHandle>>(1);
    std::thread::spawn(move || {
        match OutputStream::try_default() {
            Ok((_stream, handle)) => {
                let _ = result_tx.send(Some(handle));
                // Keep _stream alive. Recovery is rare; thread count is bounded by device-disconnect events.
                std::thread::park();
            }
            Err(e) => {
                log::warn!("audio: fallback reinit failed: {e}");
                let _ = result_tx.send(None);
            }
        }
    });
    if let Ok(Some(h)) = result_rx.recv_timeout(Duration::from_millis(500)) {
        *shared.lock().unwrap() = Some(Arc::new(h));
        log::info!("audio: recovered to OS default device");
    }
}

// ── Notification playback queue ───────────────────────────────────────────────

pub struct AudioCtx {
    queue: Arc<Mutex<VecDeque<PathBuf>>>,
    worker_started: Arc<Mutex<bool>>,
    handle: Arc<Mutex<Option<Arc<OutputStreamHandle>>>>,
}

impl AudioCtx {
    pub fn new(handle: Arc<Mutex<Option<Arc<OutputStreamHandle>>>>) -> Self {
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
    pub fn new(handle: Arc<Mutex<Option<Arc<OutputStreamHandle>>>>) -> Self {
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

fn load_source(path: &Path) -> Result<Decoder<BufReader<File>>> {
    let file = File::open(path).with_context(|| format!("open {path:?}"))?;
    Decoder::new(BufReader::new(file)).context("decode")
}

fn play_blocking(handle: &OutputStreamHandle, path: &Path) -> Result<()> {
    let file = File::open(path).with_context(|| format!("open {path:?}"))?;
    let source = Decoder::new(BufReader::new(file)).context("decode")?;
    let sink = Sink::try_new(handle).context("sink")?;
    sink.append(source);
    sink.sleep_until_end();
    Ok(())
}

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
    fn audio_stream_ctrl_handle_arc_is_shared() {
        // Works even when no audio device exists (CI). Tests that both arcs
        // point to the same allocation, not just equal values.
        let ctrl = AudioStreamCtrl::init(None);
        let arc1 = ctrl.handle_arc();
        let arc2 = ctrl.handle_arc();
        assert!(Arc::ptr_eq(&arc1, &arc2));
    }

    #[test]
    fn audio_ctx_skips_play_when_handle_is_none() {
        // No panic when handle is None and play_file is called.
        let ctx = AudioCtx::default();
        ctx.play_file(std::path::Path::new("/nonexistent/path.mp3"));
        // Worker was not started because handle was None.
        assert!(!*ctx.worker_started.lock().unwrap());
    }

    #[test]
    fn open_device_unknown_name_falls_back_to_default() {
        // Should not panic; may return None in headless CI.
        let _result = open_device(Some("__nonexistent_device_xyz__"));
        // No assertion on result - just verify it doesn't panic.
    }
}
