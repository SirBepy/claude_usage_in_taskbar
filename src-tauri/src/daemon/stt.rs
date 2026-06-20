//! STT sidecar supervisor: lazy-spawns and supervises the host-PC Python
//! `faster-whisper` speech-to-text sidecar (`stt-sidecar/server.py`), which
//! binds `127.0.0.1:27184`. Mirrors `lifecycle.rs` process handling:
//!   - lazy spawn on first `/ws/transcribe` connect (`ensure_running`),
//!   - connection tracking (`on_connect`/`on_disconnect`),
//!   - 5-min idle shutdown (`maybe_idle_shutdown`, driven by a 60s daemon tick),
//!   - graceful kill on daemon exit (`kill`).
//!
//! The sidecar is localhost-only, unauthenticated, host-PC-only; it owns its own
//! socket post-spawn and spawns no children. Windows spawns must never flash a
//! console, so every `Command` runs through `hide_console_tokio`.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

pub const SIDECAR_PORT: u16 = 27184;
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);

pub struct SttSupervisor {
    app_data: PathBuf,
    child: Mutex<Option<Child>>,
    active_conns: AtomicUsize,
    last_active: Mutex<Instant>,
}

impl SttSupervisor {
    pub fn new(app_data: PathBuf) -> Arc<Self> {
        // Seed a default hotword vocab so the sidecar biases toward the project's
        // jargon on first ever boot. Best-effort: a write failure just means an
        // empty hotword string (the sidecar tolerates a missing file).
        let vdir = app_data.join("voice");
        let _ = std::fs::create_dir_all(&vdir);
        let vfile = vdir.join("voice-vocab.json");
        if !vfile.exists() {
            let seed = serde_json::json!({ "terms": [
                "Tauri","Riverpod","tailscale","daemon","Anthropic","Phosphor",
                "Claude","Opus","Sonnet","companion","webview","vitest","Playwright"
            ]});
            let _ = std::fs::write(&vfile, serde_json::to_string_pretty(&seed).unwrap_or_default());
        }

        Arc::new(Self {
            app_data,
            child: Mutex::new(None),
            active_conns: AtomicUsize::new(0),
            last_active: Mutex::new(Instant::now()),
        })
    }

    fn sidecar_dir(&self) -> PathBuf {
        // stt-sidecar/ sits at the repo/install root next to the daemon exe.
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("stt-sidecar")))
            .unwrap_or_else(|| PathBuf::from("stt-sidecar"))
    }

    pub async fn ensure_running(&self) -> Result<(), String> {
        let mut guard = self.child.lock().await;
        if let Some(c) = guard.as_mut() {
            if matches!(c.try_wait(), Ok(None)) {
                return Ok(()); // still alive
            }
        }
        let dir = self.sidecar_dir();
        let python = dir
            .join(".venv")
            .join(if cfg!(windows) { "Scripts/python.exe" } else { "bin/python" });
        let mut cmd = Command::new(if python.exists() { python } else { PathBuf::from("python") });
        cmd.current_dir(&dir)
            .arg("server.py")
            .arg("--app-data")
            .arg(&self.app_data)
            .arg("--port")
            .arg(SIDECAR_PORT.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::util::process::hide_console_tokio(&mut cmd);
        let child = cmd.spawn().map_err(|e| format!("spawn stt-sidecar: {e}"))?;
        log::info!("stt-sidecar spawned (pid {:?})", child.id());
        *guard = Some(child);
        Ok(())
    }

    pub fn on_connect(&self) {
        self.active_conns.fetch_add(1, Ordering::SeqCst);
    }

    pub async fn on_disconnect(&self) {
        self.active_conns.fetch_sub(1, Ordering::SeqCst);
        *self.last_active.lock().await = Instant::now();
    }

    pub async fn maybe_idle_shutdown(&self) {
        if self.active_conns.load(Ordering::SeqCst) > 0 {
            return;
        }
        if self.last_active.lock().await.elapsed() < IDLE_TIMEOUT {
            return;
        }
        self.kill().await;
    }

    pub async fn kill(&self) {
        if let Some(mut c) = self.child.lock().await.take() {
            let _ = c.kill().await;
            log::info!("stt-sidecar killed (idle/shutdown)");
        }
    }
}
