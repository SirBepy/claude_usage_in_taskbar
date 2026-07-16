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
use tokio::io::{AsyncBufReadExt, BufReader};
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
        // Find the dir that actually holds `stt-sidecar/server.py`. Resolution
        // order (first hit wins) so it works for a dev run AND an installed app
        // whose exe is in Program Files while stt-sidecar/ lives in the repo:
        //   1. CC_STT_SIDECAR_DIR env var (explicit override).
        //   2. <app_data>/voice/sidecar-path.txt (a recorded path; lets the
        //      installed app point at the repo without bundling the venv).
        //   3. walk up from the exe (bundled next-to-exe, or dev target/debug).
        //   4. walk up from the working dir.
        let has = |d: &std::path::Path| d.join("server.py").exists();

        if let Ok(p) = std::env::var("CC_STT_SIDECAR_DIR") {
            let d = PathBuf::from(p.trim());
            if has(&d) {
                return d;
            }
        }

        let pathfile = self.app_data.join("voice").join("sidecar-path.txt");
        if let Ok(raw) = std::fs::read_to_string(&pathfile) {
            // Strip a possible UTF-8 BOM (editors/PowerShell add one) before trim.
            let d = PathBuf::from(raw.trim_start_matches('\u{feff}').trim());
            if has(&d) {
                return d;
            }
        }

        let walk_up = |start: Option<&std::path::Path>| -> Option<PathBuf> {
            let mut dir = start.map(|p| p.to_path_buf());
            for _ in 0..8 {
                let d = dir?;
                let cand = d.join("stt-sidecar");
                if has(&cand) {
                    return Some(cand);
                }
                dir = d.parent().map(|p| p.to_path_buf());
            }
            None
        };

        if let Ok(exe) = std::env::current_exe() {
            if let Some(found) = walk_up(exe.parent()) {
                return found;
            }
        }
        if let Ok(cwd) = std::env::current_dir() {
            if let Some(found) = walk_up(Some(cwd.as_path())) {
                return found;
            }
        }
        PathBuf::from("stt-sidecar")
    }

    pub async fn ensure_running(&self) -> Result<(), String> {
        let mut guard = self.child.lock().await;
        if let Some(c) = guard.as_mut() {
            match c.try_wait() {
                Ok(None) => return Ok(()), // still alive
                Ok(Some(status)) => {
                    // ai_todo 228: prior sessions repeatedly found sidecar-respawn
                    // clusters near unexplained daemon pipe drops, with zero
                    // diagnostic output either time. Surface the exit status so a
                    // future occurrence at least has a reason instead of silence.
                    log::warn!("stt-sidecar exited unexpectedly (status {status:?}); respawning");
                }
                Err(e) => {
                    // Ambiguous liveness - don't trust it's gone. Kill explicitly
                    // before replacing the handle so a still-alive process can't
                    // linger holding the port and starve the next spawn attempt.
                    log::warn!("stt-sidecar liveness check failed ({e}); killing stale handle before respawning");
                    let _ = c.kill().await;
                }
            }
        }
        let dir = self.sidecar_dir();
        if !dir.join("server.py").exists() {
            return Err(format!(
                "stt-sidecar not found at {dir:?} (set CC_STT_SIDECAR_DIR or write \
                 <app-data>/voice/sidecar-path.txt to point at the repo's stt-sidecar)"
            ));
        }
        let python = dir
            .join(".venv")
            .join(if cfg!(windows) { "Scripts/python.exe" } else { "bin/python" });
        log::info!("stt-sidecar dir resolved to {dir:?} (python: {})", python.exists());
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
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("spawn stt-sidecar in {dir:?}: {e}"))?;
        log::info!("stt-sidecar spawned (pid {:?})", child.id());
        // Drain stderr in the background so an early crash (e.g. a port-bind
        // race against a not-yet-exited previous instance) leaves a reason in
        // the log instead of vanishing into the piped-but-never-read handle.
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    log::warn!("stt-sidecar stderr: {line}");
                }
            });
        }
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
