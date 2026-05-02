//! Audio playback queue. One consumer thread, 200ms gap between entries so
//! back-to-back notifications don't overlap.

use anyhow::{Context, Result};
use rodio::{Decoder, OutputStream, Sink};
use std::collections::VecDeque;
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::AppHandle;

const GAP: Duration = Duration::from_millis(200);

pub struct AudioCtx {
    queue: Arc<Mutex<VecDeque<PathBuf>>>,
    worker_started: Arc<Mutex<bool>>,
}

impl AudioCtx {
    pub fn new() -> Self {
        Self {
            queue: Arc::new(Mutex::new(VecDeque::new())),
            worker_started: Arc::new(Mutex::new(false)),
        }
    }

    pub fn play_file(&self, path: impl AsRef<Path>) {
        self.queue.lock().unwrap().push_back(path.as_ref().to_path_buf());
        self.ensure_worker();
    }

    fn ensure_worker(&self) {
        let mut started = self.worker_started.lock().unwrap();
        if *started { return; }
        *started = true;
        let queue = Arc::clone(&self.queue);
        let flag = Arc::clone(&self.worker_started);
        std::thread::spawn(move || {
            let stream = OutputStream::try_default();
            let Ok((_stream, handle)) = stream else {
                log::warn!("audio: failed to init output stream");
                *flag.lock().unwrap() = false;
                return;
            };
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

impl Default for AudioCtx { fn default() -> Self { Self::new() } }

fn play_blocking(handle: &rodio::OutputStreamHandle, path: &Path) -> Result<()> {
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
