use crate::settings::paths;
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
    let log_path = paths::log_file().map_err(|e| e.to_string())?;
    let contents = std::fs::read_to_string(&log_path).unwrap_or_else(|_| "<no log file>".into());
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
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
pub async fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    #[allow(deprecated)]
    app.shell().open(url, None).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<serde_json::Value, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(u)) => Ok(serde_json::json!({ "state": "available", "version": u.version })),
        Ok(None) => Ok(serde_json::json!({ "state": "up-to-date" })),
        Err(e) => Ok(serde_json::json!({ "state": "error", "message": e.to_string() })),
    }
}

#[tauri::command]
pub async fn download_and_install_update(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Err("no update available".into());
    };
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn install_update(app: AppHandle) {
    app.restart();
}

#[tauri::command]
pub fn get_update_state() -> serde_json::Value {
    serde_json::json!({ "state": "idle" })
}

#[tauri::command]
pub fn list_sound_packs() -> Vec<crate::notifications::soundpacks::SoundPack> {
    crate::notifications::soundpacks::list_with_installed_state()
}

#[tauri::command]
pub async fn install_sound_pack(pack_id: String) -> Result<(), String> {
    crate::notifications::soundpacks::install(&pack_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sound_pack_file_url(pack: String, sound: String) -> Option<String> {
    crate::notifications::soundpacks::file_data_url(&pack, &sound)
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

#[tauri::command]
pub fn play_pack_sound_preview(app: AppHandle, pack: String, sound: String) -> Result<(), String> {
    let invalid = |s: &str| s.is_empty() || s.contains('/') || s.contains('\\') || s.contains("..");
    if invalid(&pack) || invalid(&sound) {
        return Err("invalid pack or sound".into());
    }
    crate::notifications::audio::play_pack_sound(&app, &pack, &sound);
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
