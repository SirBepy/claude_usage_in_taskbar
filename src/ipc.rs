//! IPC commands exposed to the webview via `invoke()`.

use crate::state::AppState;
use crate::token_stats::{self, BackfillResult, TokenRecord};
use crate::types::{AuthState, ProjectConfig, Settings, UsageSnapshot, ViewMode};
use crate::{history, paths, session, settings};
use tauri::{AppHandle, Emitter, Manager, State};

#[tauri::command]
pub fn get_current_usage(state: State<AppState>) -> Option<UsageSnapshot> {
    state.current_usage.lock().unwrap().clone()
}

#[tauri::command]
pub fn get_history(limit: Option<u32>) -> Vec<UsageSnapshot> {
    let path = match paths::history_file() { Ok(p) => p, Err(_) => return vec![] };
    let mut all = history::load_all(&path).unwrap_or_default();
    if let Some(n) = limit {
        let start = all.len().saturating_sub(n as usize);
        all = all.split_off(start);
    }
    all
}

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
pub fn save_settings(updated: Settings, state: State<AppState>, app: AppHandle)
    -> Result<(), String>
{
    let path = paths::settings_file().map_err(|e| e.to_string())?;
    settings::save(&path, &updated).map_err(|e| e.to_string())?;
    *state.settings.lock().unwrap() = updated.clone();
    let _ = app.emit("settings-changed", updated);
    Ok(())
}

#[tauri::command]
pub fn auth_status(state: State<AppState>) -> AuthState {
    *state.auth_state.lock().unwrap()
}

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

// Deferred to their own tasks:
//   poll_now     -> Task 9 (scheduler)
//   start_login  -> Task 13 (auth)

/// Convenience: clears the stored session.
#[tauri::command]
pub fn logout(state: State<AppState>, app: AppHandle) -> Result<(), String> {
    let path = paths::session_file().map_err(|e| e.to_string())?;
    session::clear(&path).map_err(|e| e.to_string())?;
    *state.auth_state.lock().unwrap() = AuthState::NeedsLogin;
    *state.current_usage.lock().unwrap() = None;
    let _ = app.emit("usage-updated", serde_json::Value::Null);
    let _ = app.emit("auth-progress", serde_json::json!({"stage": "needs-login"}));
    Ok(())
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
    // tauri-plugin-log's default filename is "<product-name>.log".
    let product = app.package_info().name.clone();
    let log_path = log_dir.join(format!("{product}.log"));
    read_log_contents(&log_path)
}

/// Pure helpers extracted from the Tauri command wrappers so they can be
/// unit-tested without standing up a full app handle.
pub mod projects_test_helpers {
    use crate::types::{ProjectConfig, Settings, ViewMode};

    pub fn list_from(s: &Settings) -> Vec<ProjectConfig> { s.projects.clone() }

    pub fn get_from(s: &Settings, id: &str) -> Option<ProjectConfig> {
        s.projects.iter().find(|p| p.id == id).cloned()
    }

    /// Applies a partial JSON patch in-place. Unknown keys are ignored.
    /// Returns `true` if the project existed.
    pub fn update_in(s: &mut Settings, id: &str, patch: serde_json::Value)
        -> bool
    {
        let Some(p) = s.projects.iter_mut().find(|p| p.id == id) else {
            return false;
        };
        // Round-trip the project through JSON, apply the patch, deserialize
        // back. This gives us a free partial update without per-field code.
        let mut obj = serde_json::to_value(&*p).ok().and_then(|v| v.as_object().cloned()).unwrap_or_default();
        if let Some(patch_obj) = patch.as_object() {
            for (k, v) in patch_obj {
                obj.insert(k.clone(), v.clone());
            }
        }
        if let Ok(updated) = serde_json::from_value::<ProjectConfig>(serde_json::Value::Object(obj)) {
            *p = updated;
            true
        } else {
            false
        }
    }

    pub fn delete_in(s: &mut Settings, id: &str) -> bool {
        let before = s.projects.len();
        s.projects.retain(|p| p.id != id);
        s.projects.len() < before
    }

    pub fn set_view_mode(s: &mut Settings, mode: ViewMode) {
        s.projects_view_mode = mode;
    }
}

#[tauri::command]
pub fn list_projects(state: State<AppState>) -> Vec<ProjectConfig> {
    projects_test_helpers::list_from(&state.settings.lock().unwrap())
}

#[tauri::command]
pub fn get_project(id: String, state: State<AppState>) -> Option<ProjectConfig> {
    projects_test_helpers::get_from(&state.settings.lock().unwrap(), &id)
}

#[tauri::command]
pub fn update_project(
    id: String,
    patch: serde_json::Value,
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let settings_path = paths::settings_file().map_err(|e| e.to_string())?;
    let mut guard = state.settings.lock().unwrap();
    if !projects_test_helpers::update_in(&mut guard, &id, patch) {
        return Err(format!("project {id} not found"));
    }
    settings::save(&settings_path, &guard).map_err(|e| e.to_string())?;
    let snapshot = guard.clone();
    drop(guard);
    let _ = app.emit("settings-changed", snapshot);
    Ok(())
}

#[tauri::command]
pub fn delete_project(
    id: String,
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let settings_path = paths::settings_file().map_err(|e| e.to_string())?;
    let mut guard = state.settings.lock().unwrap();
    if !projects_test_helpers::delete_in(&mut guard, &id) {
        return Err(format!("project {id} not found"));
    }
    settings::save(&settings_path, &guard).map_err(|e| e.to_string())?;
    let snapshot = guard.clone();
    drop(guard);
    let _ = app.emit("settings-changed", snapshot);
    Ok(())
}

#[tauri::command]
pub fn set_projects_view_mode(
    mode: ViewMode,
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let settings_path = paths::settings_file().map_err(|e| e.to_string())?;
    let mut guard = state.settings.lock().unwrap();
    projects_test_helpers::set_view_mode(&mut guard, mode);
    settings::save(&settings_path, &guard).map_err(|e| e.to_string())?;
    let snapshot = guard.clone();
    drop(guard);
    let _ = app.emit("settings-changed", snapshot);
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
        use super::check_paths_exist;
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

/// Open a filesystem path in the OS file manager (Explorer on Windows,
/// Finder on macOS, default handler on Linux).
#[tauri::command]
pub fn open_in_explorer(path: String) -> Result<(), String> {
    if path.is_empty() { return Err("empty path".into()) }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("explorer spawn failed: {e}"))
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(&path).spawn()
            .map(|_| ()).map_err(|e| format!("open spawn failed: {e}"))
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open").arg(&path).spawn()
            .map(|_| ()).map_err(|e| format!("xdg-open spawn failed: {e}"))
    }
}

/// Open a folder in VS Code. Uses the `code` (or `code.cmd` on Windows)
/// launcher that ships with VS Code, which must be on PATH (users who
/// installed VS Code on Windows normally have it).
#[tauri::command]
pub fn open_in_vscode(path: String) -> Result<(), String> {
    if path.is_empty() { return Err("empty path".into()) }
    #[cfg(target_os = "windows")]
    {
        // `code` on Windows is a .cmd shim; invoke via `cmd /c` so we don't
        // have to worry about PATHEXT lookup semantics from spawn().
        std::process::Command::new("cmd")
            .args(["/C", "code", "-n", &path])
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("code launch failed: {e}"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("code").args(["-n", &path]).spawn()
            .map(|_| ()).map_err(|e| format!("code launch failed: {e}"))
    }
}

/// Bulk existence check for project directories. The dashboard passes the
/// cwds it has token history for, and we reply with `{path: bool}` so the
/// renderer can flag genuinely-deleted folders (and hide the warning on
/// live ones, which was the bug here).
#[tauri::command]
pub fn check_paths_exist(paths: Vec<String>) -> std::collections::HashMap<String, bool> {
    paths
        .into_iter()
        .map(|p| {
            let exists = std::path::Path::new(&p).exists();
            (p, exists)
        })
        .collect()
}

#[tauri::command]
pub fn get_token_history() -> Vec<TokenRecord> {
    let Ok(path) = paths::token_history_file() else { return vec![] };
    token_stats::load_history(&path)
}

#[tauri::command]
pub async fn get_active_sessions() -> Vec<TokenRecord> {
    let path = match paths::token_history_file() { Ok(p) => p, Err(_) => return vec![] };
    // Filesystem walk + transcript parse can take a while on big projects
    // dirs, so offload off the main async runtime to keep IPC snappy.
    tauri::async_runtime::spawn_blocking(move || token_stats::active_sessions(&path))
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub async fn backfill_transcripts(app: AppHandle) -> Result<BackfillResult, String> {
    let path = paths::token_history_file().map_err(|e| e.to_string())?;
    let path2 = path.clone();
    let result = tauri::async_runtime::spawn_blocking(move || token_stats::backfill_all(&path2))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    // Tell the dashboard to refetch.
    let history = token_stats::load_history(&path);
    let _ = app.emit("token-history-updated", history);
    Ok(result)
}

#[tauri::command]
pub fn piper_status() -> crate::piper::PiperStatus {
    crate::piper::status()
}

#[tauri::command]
pub async fn piper_install_voice(id: String) -> Result<(), String> {
    crate::piper::install_voice(&id).await.map_err(|e| e.to_string())
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
    crate::audio::play_sound_file(&app, &filename);
    Ok(())
}

#[tauri::command]
pub fn play_pack_sound_preview(app: AppHandle, pack: String, sound: String) -> Result<(), String> {
    let invalid = |s: &str| s.is_empty() || s.contains('/') || s.contains('\\') || s.contains("..");
    if invalid(&pack) || invalid(&sound) {
        return Err("invalid pack or sound".into());
    }
    crate::audio::play_pack_sound(&app, &pack, &sound);
    Ok(())
}

#[tauri::command]
pub async fn poll_now(app: AppHandle) -> Result<UsageSnapshot, String> {
    match crate::scheduler::poll_once(&app, crate::scheduler::PollTrigger::Manual).await {
        Ok(snap) => {
            let _ = app.emit("usage-updated", snap.clone());
            Ok(snap)
        }
        Err(e) => Err(format!("{e:?}")),
    }
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
pub async fn start_login(app: AppHandle) -> Result<(), String> {
    {
        let state = app.state::<AppState>();
        *state.auth_state.lock().unwrap() = AuthState::InProgress;
    }
    let _ = app.emit("auth-progress", serde_json::json!({"stage": "starting"}));
    match crate::auth::run(app.clone()).await {
        Ok(()) => {
            let state = app.state::<AppState>();
            *state.auth_state.lock().unwrap() = AuthState::LoggedIn;
            // Kick an immediate poll so the dashboard shows data right away.
            let h = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = crate::scheduler::poll_once(&h, crate::scheduler::PollTrigger::Manual).await;
            });
            Ok(())
        }
        Err(e) => {
            let state = app.state::<AppState>();
            *state.auth_state.lock().unwrap() = AuthState::NeedsLogin;
            Err(e.to_string())
        }
    }
}

#[tauri::command]
pub fn list_sound_packs() -> Vec<crate::soundpacks::SoundPack> {
    crate::soundpacks::list_with_installed_state()
}

#[tauri::command]
pub async fn install_sound_pack(pack_id: String) -> Result<(), String> {
    crate::soundpacks::install(&pack_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sound_pack_file_url(pack: String, sound: String) -> Option<String> {
    crate::soundpacks::file_data_url(&pack, &sound)
}

// --- Instances ---

#[tauri::command]
pub fn list_instances(state: State<AppState>) -> Vec<crate::types::Instance> {
    state.instances.list()
}

#[tauri::command]
pub fn list_instances_for_project(
    project_id: String,
    state: State<AppState>,
) -> Vec<crate::types::Instance> {
    state.instances.by_project(&project_id)
}

#[tauri::command]
pub fn phone_link(session_id: String, state: State<AppState>) -> Option<String> {
    let inst = state.instances.get(&session_id)?;
    let bridge = inst.bridge_session_id?;
    Some(format!("https://claude.ai/code/{bridge}"))
}

// --- Hook registration ---

#[tauri::command]
pub fn get_hook_registration_state(state: State<AppState>) -> serde_json::Value {
    let s = state.settings.lock().unwrap();
    serde_json::json!({
        "registered": s.hooks_registered,
        "declined": s.hook_registration_declined,
        "port": s.hook_port,
    })
}

#[tauri::command]
pub fn register_hooks_globally(
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let port = {
        let s = state.settings.lock().unwrap();
        s.hook_port.ok_or_else(|| "hook server not started yet".to_string())?
    };
    crate::hook_installer::install(crate::hook_installer::HookConfig { port })
        .map_err(|e| e.to_string())?;
    let snapshot = {
        let mut g = state.settings.lock().unwrap();
        g.hooks_registered = true;
        g.hook_registration_declined = false;
        g.clone()
    };
    let path = paths::settings_file().map_err(|e| e.to_string())?;
    settings::save(&path, &snapshot).map_err(|e| e.to_string())?;
    let _ = app.emit("settings-changed", snapshot);
    Ok(())
}

#[tauri::command]
pub fn skip_hook_registration(
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let snapshot = {
        let mut g = state.settings.lock().unwrap();
        g.hook_registration_declined = true;
        g.clone()
    };
    let path = paths::settings_file().map_err(|e| e.to_string())?;
    settings::save(&path, &snapshot).map_err(|e| e.to_string())?;
    let _ = app.emit("settings-changed", snapshot);
    Ok(())
}
