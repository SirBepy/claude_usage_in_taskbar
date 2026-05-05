use tauri::{AppHandle, Manager};

#[tauri::command]
pub fn open_dashboard(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    use std::sync::atomic::Ordering;
    if let Some(state) = app.try_state::<crate::state::AppState>() {
        state.should_quit.store(true, Ordering::SeqCst);
    }
    app.exit(0);
}

/// Reads a log file from disk, returning a friendly placeholder when it does
/// not exist yet (common on a fresh install before the first log line is
/// written). Extracted from the Tauri command so it can be unit-tested.
pub fn read_log_contents(log_path: &std::path::Path) -> Result<String, String> {
    match std::fs::read_to_string(log_path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Ok(format!("(no log file yet at {})", log_path.display()))
        }
        Err(e) => Err(format!("reading {}: {e}", log_path.display())),
    }
}

/// Reads the tauri-plugin-log log file and returns its contents as a string.
/// The renderer writes this to the clipboard for bug reports.
#[tauri::command]
pub fn read_log_file(app: AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let log_dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    let product = app.package_info().name.clone();
    let log_path = log_dir.join(format!("{product}.log"));
    read_log_contents(&log_path)
}

#[tauri::command]
pub fn copy_logs(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let log_dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    let product = app.package_info().name.clone();
    let log_path = log_dir.join(format!("{product}.log"));
    let contents = read_log_contents(&log_path).unwrap_or_else(|e| format!("<error reading log: {e}>"));
    app.clipboard().write_text(contents).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_platform() -> String {
    match std::env::consts::OS {
        "macos" => "darwin".into(),
        "windows" => "win32".into(),
        other => other.into(),
    }
}

#[tauri::command]
pub fn get_app_version(app: AppHandle) -> String {
    // tauri.conf.json is the source of truth (CI bumps it). Cargo.toml is
    // synced in CI but may lag in dev. Fall back to CARGO_PKG_VERSION just
    // in case Tauri ever returns an empty config version.
    let cfg = app.config().version.clone();
    cfg.filter(|v| !v.is_empty())
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
}

#[tauri::command]
pub async fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    #[allow(deprecated)]
    app.shell().open(url, None).map_err(|e| e.to_string())
}

/// Caches the latest update state in AppState and emits `update-state` so the
/// settings UI + tray menu can stay in sync without polling.
pub fn set_update_state(app: &AppHandle, value: serde_json::Value) {
    use tauri::Emitter;
    if let Some(state) = app.try_state::<crate::state::AppState>() {
        *state.update_state.lock().unwrap() = value.clone();
    }
    let _ = app.emit("update-state", &value);
}

/// Runs the updater check and emits an `update-state` event for every outcome
/// so the settings UI can surface progress without polling. When `auto_install`
/// is true and an update is available, the binary is downloaded + installed in
/// the background; the app restarts on next launch.
pub async fn run_update_check(app: &AppHandle, auto_install: bool) -> serde_json::Value {
    use tauri_plugin_updater::UpdaterExt;
    let result = match app.updater() {
        Ok(updater) => match updater.check().await {
            Ok(Some(u)) => {
                let version = u.version.clone();
                let available = serde_json::json!({ "state": "available", "version": version });
                set_update_state(app, available.clone());
                if auto_install {
                    set_update_state(app, serde_json::json!({ "state": "downloading", "version": version }));
                    match u.download_and_install(|_, _| {}, || {}).await {
                        Ok(_) => {
                            let downloaded = serde_json::json!({ "state": "downloaded", "version": version });
                            set_update_state(app, downloaded.clone());
                            return downloaded;
                        }
                        Err(e) => {
                            log::warn!("auto-install failed: {e}");
                            let err = serde_json::json!({ "state": "error", "message": e.to_string() });
                            set_update_state(app, err.clone());
                            return err;
                        }
                    }
                }
                return available;
            }
            Ok(None) => serde_json::json!({ "state": "up-to-date" }),
            Err(e) => serde_json::json!({ "state": "error", "message": e.to_string() }),
        },
        Err(e) => serde_json::json!({ "state": "error", "message": e.to_string() }),
    };
    set_update_state(app, result.clone());
    result
}

#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    use crate::types::AutoUpdateMode;
    let auto_install = app.state::<crate::state::AppState>()
        .settings.lock().unwrap().auto_update == AutoUpdateMode::Immediate;
    Ok(run_update_check(&app, auto_install).await)
}

#[tauri::command]
pub async fn download_and_install_update(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Err("no update available".into());
    };
    let version = update.version.clone();
    set_update_state(&app, serde_json::json!({ "state": "downloading", "version": version }));
    match update.download_and_install(|_, _| {}, || {}).await {
        Ok(_) => {
            set_update_state(&app, serde_json::json!({ "state": "downloaded", "version": version }));
            Ok(())
        }
        Err(e) => {
            let msg = e.to_string();
            set_update_state(&app, serde_json::json!({ "state": "error", "message": msg.clone() }));
            Err(msg)
        }
    }
}

#[tauri::command]
pub fn install_update(app: AppHandle) {
    app.restart();
}

#[tauri::command]
pub fn get_update_state(app: AppHandle) -> serde_json::Value {
    app.state::<crate::state::AppState>().update_state.lock().unwrap().clone()
}

#[tauri::command]
pub fn piper_status() -> crate::notifications::piper::PiperStatus {
    crate::notifications::piper::status()
}

#[tauri::command]
pub async fn piper_install_voice(id: String) -> Result<(), String> {
    crate::notifications::piper::install_voice(&id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn piper_speak_preview(app: AppHandle, text: String, voice_name: Option<String>) -> Result<(), String> {
    crate::notifications::speak_public(&app, &text, voice_name.as_deref());
    Ok(())
}

#[tauri::command]
pub fn play_sound_preview(app: AppHandle, filename: String) -> Result<(), String> {
    if filename.is_empty()
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains("..")
    {
        return Err("invalid sound filename".into());
    }
    crate::notifications::audio::play_sound_file(&app, &filename);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::read_log_contents;
    use tempfile::tempdir;

    #[test]
    fn returns_placeholder_when_log_missing() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("does-not-exist.log");
        let out = read_log_contents(&path).unwrap();
        assert!(out.starts_with("(no log file yet at "), "got: {out}");
    }

    #[test]
    fn returns_file_contents_when_present() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("app.log");
        std::fs::write(&path, "line 1\nline 2\n").unwrap();
        assert_eq!(read_log_contents(&path).unwrap(), "line 1\nline 2\n");
    }

    #[test]
    fn check_paths_exist_reports_each_path_independently() {
        use super::super::projects::check_paths_exist;
        let dir = tempdir().unwrap();
        let real = dir.path().join("real");
        std::fs::create_dir(&real).unwrap();
        let fake = dir.path().join("not-here");

        let result = check_paths_exist(vec![
            real.to_string_lossy().to_string(),
            fake.to_string_lossy().to_string(),
        ]);
        assert_eq!(result[&real.to_string_lossy().to_string()], true);
        assert_eq!(result[&fake.to_string_lossy().to_string()], false);
    }
}
