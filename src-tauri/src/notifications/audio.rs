//! Audio playback queue. One consumer thread, 200ms gap between entries so
//! back-to-back notifications don't overlap.
//!
//! A single `OutputStream` is kept alive on a dedicated background thread and
//! both `AudioCtx` and `PreviewCtx` receive a clone of the `OutputStreamHandle`.
//! This avoids creating two WASAPI clients from the same process, which can
//! fail silently on some Windows audio drivers.

use anyhow::{Context, Result};
use rodio::{Decoder, OutputStream, OutputStreamHandle, Sink};
use std::collections::VecDeque;
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const GAP: Duration = Duration::from_millis(200);

// ── Shared stream init ────────────────────────────────────────────────────────

/// Spawn a background thread that holds the `OutputStream` alive for the entire
/// app lifetime.  Returns a cloneable `OutputStreamHandle` on success.
/// `OutputStream` is `!Send`, so it must stay on the thread that created it.
pub fn init_audio_handle() -> Option<Arc<OutputStreamHandle>> {
    let (tx, rx) = std::sync::mpsc::channel::<Option<OutputStreamHandle>>();
    std::thread::spawn(move || {
        match OutputStream::try_default() {
            Ok((_stream, handle)) => {
                let _ = tx.send(Some(handle));
                // Keep _stream alive — once this thread exits the stream drops
                // and all sinks go silent.
                loop { std::thread::sleep(Duration::from_secs(3600)); }
            }
            Err(e) => {
                log::warn!("audio: failed to init output stream: {e}");
                let _ = tx.send(None);
            }
        }
    });
    // 500 ms grace period — if the audio device isn't ready by then, disable
    // audio rather than blocking the whole app startup (which delays the hook
    // server on port 27182 and causes incoming Stop hooks to fail).
    rx.recv_timeout(std::time::Duration::from_millis(500))
        .ok()
        .flatten()
        .map(Arc::new)
}

// ── Notification playback queue ───────────────────────────────────────────────

pub struct AudioCtx {
    queue: Arc<Mutex<VecDeque<PathBuf>>>,
    worker_started: Arc<Mutex<bool>>,
    handle: Option<Arc<OutputStreamHandle>>,
}

impl AudioCtx {
    pub fn new(handle: Option<Arc<OutputStreamHandle>>) -> Self {
        Self {
            queue: Arc::new(Mutex::new(VecDeque::new())),
            worker_started: Arc::new(Mutex::new(false)),
            handle,
        }
    }

    pub fn play_file(&self, path: impl AsRef<Path>) {
        let Some(ref handle) = self.handle else { return; };
        self.queue.lock().unwrap().push_back(path.as_ref().to_path_buf());
        self.ensure_worker(Arc::clone(handle));
    }

    fn ensure_worker(&self, handle: Arc<OutputStreamHandle>) {
        let mut started = self.worker_started.lock().unwrap();
        if *started { return; }
        *started = true;
        let queue = Arc::clone(&self.queue);
        let flag = Arc::clone(&self.worker_started);
        std::thread::spawn(move || {
            loop {
                let next = queue.lock().unwrap().pop_front();
                match next {
                    Some(path) => {
                        if let Err(e) = play_blocking(&handle, &path) {
                            log::warn!("audio play failed: {e}");
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
    fn default() -> Self { Self::new(None) }
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
    tx: std::sync::mpsc::SyncSender<PreviewMsg>,
}

impl PreviewCtx {
    pub fn new(handle: Option<Arc<OutputStreamHandle>>) -> Self {
        let (tx, rx) = std::sync::mpsc::sync_channel::<PreviewMsg>(4);
        if let Some(handle) = handle {
            std::thread::spawn(move || {
                let mut active: Option<(Sink, AppHandle)> = None;
                loop {
                    match rx.try_recv() {
                        Ok(PreviewMsg::Play(path, app)) => {
                            if let Some((s, _)) = active.take() { s.stop(); }
                            match Sink::try_new(&handle) {
                                Ok(sink) => match load_source(&path) {
                                    Ok(src) => {
                                        sink.append(src);
                                        active = Some((sink, app));
                                    }
                                    Err(e) => log::warn!("preview decode failed: {e}"),
                                },
                                Err(e) => log::warn!("preview sink create failed: {e}"),
                            }
                        }
                        Ok(PreviewMsg::Stop) => {
                            if let Some((s, _)) = active.take() { s.stop(); }
                        }
                        Err(std::sync::mpsc::TryRecvError::Empty) => {}
                        Err(std::sync::mpsc::TryRecvError::Disconnected) => break,
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
        } else {
            // No audio device — drain the channel so senders never block.
            std::thread::spawn(move || {
                while rx.recv().is_ok() {}
            });
        }
        Self { tx }
    }

    pub fn play(&self, path: PathBuf, app: AppHandle) {
        let _ = self.tx.try_send(PreviewMsg::Play(path, app));
    }

    pub fn stop(&self) {
        let _ = self.tx.try_send(PreviewMsg::Stop);
    }
}

impl Default for PreviewCtx { fn default() -> Self { Self::new(None) } }

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
