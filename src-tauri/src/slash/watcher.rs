use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

const DEBOUNCE: Duration = Duration::from_millis(300);

pub fn spawn(app: AppHandle) {
    let Some(home_dir) = dirs::home_dir() else {
        log::warn!("[slash::watcher] no home dir; skipping");
        return;
    };
    let home_claude = home_dir.join(".claude");

    let last = Arc::new(Mutex::new(Instant::now() - DEBOUNCE * 2));
    let app_for_cb = app.clone();
    let last_for_cb = last.clone();

    let mut watcher = match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_err() {
            return;
        }
        let mut g = last_for_cb.lock().unwrap();
        if g.elapsed() < DEBOUNCE {
            return;
        }
        *g = Instant::now();
        drop(g);
        let _ = app_for_cb.emit("slash-commands-changed", ());
    }) {
        Ok(w) => w,
        Err(e) => {
            log::error!("[slash::watcher] init failed: {e}");
            return;
        }
    };

    for sub in ["commands", "skills", "plugins/cache"] {
        let p = home_claude.join(sub);
        if p.exists() {
            if let Err(e) = watcher.watch(&p, RecursiveMode::Recursive) {
                log::warn!("[slash::watcher] watch {} failed: {e}", p.display());
            }
        }
    }

    // Keep watcher alive for app lifetime.
    Box::leak(Box::new(watcher));
    log::info!("[slash::watcher] running");
}
