use tauri::{AppHandle, Manager};

#[tauri::command]
pub fn open_dashboard(app: AppHandle) {
    use tauri::Emitter;
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.emit("navigate-to-dashboard", ());
    }
}

/// Surfaces the main dashboard window and tells it to navigate to a specific
/// project's detail page. Called from the chats window's per-chat menu so the
/// user can jump to a project's dashboard view without leaving the chat
/// window's process (it stays open in the background).
#[tauri::command]
pub fn open_dashboard_project(app: AppHandle, cwd: String) {
    use tauri::Emitter;
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.emit("navigate-to-project", cwd);
    }
}

/// Build the chats window (label `session-chats`). Built hidden so
/// tauri-plugin-window-state can restore the saved size + position before the
/// window is ever painted. Without this the window flashes briefly at the
/// inner_size default in the OS-default spot, then jumps to its remembered
/// geometry. Shown + focused right after build (the plugin restores state
/// synchronously during window creation).
fn build_chats_window(app: &AppHandle) -> Result<(), String> {
    let window = tauri::WebviewWindowBuilder::new(
        app,
        "session-chats",
        tauri::WebviewUrl::App("index.html?chatswindow=1#sessions".into()),
    )
    .title("Claude Chats")
    .inner_size(1280.0, 860.0)
    .min_inner_size(600.0, 400.0)
    .resizable(true)
    .visible(false)
    .build()
    .map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn open_chats_window(app: AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("session-chats") {
        let _ = existing.show();
        existing.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    build_chats_window(&app)
}

/// Open (or focus) the chats window and tell it to surface a specific session.
/// `mode` is "live" (select the running session) or "history" (open it
/// read-only in the History view). When the window already exists we emit
/// `chats-open-session` for its live listener; when it must be created fresh we
/// stash the request in `AppState.pending_chat_open` for the window to drain on
/// boot (the freshly-built webview can't reliably catch an event emitted before
/// its listener mounts).
#[tauri::command]
pub fn open_chats_for_session(app: AppHandle, session_id: String, mode: String) -> Result<(), String> {
    use tauri::Emitter;
    if let Some(existing) = app.get_webview_window("session-chats") {
        let _ = existing.show();
        existing.set_focus().map_err(|e| e.to_string())?;
        let _ = app.emit(
            "chats-open-session",
            serde_json::json!({ "sessionId": session_id, "mode": mode }),
        );
        return Ok(());
    }
    if let Some(state) = app.try_state::<crate::state::AppState>() {
        if let Ok(mut pending) = state.pending_chat_open.lock() {
            *pending = Some((session_id, mode));
        }
    }
    build_chats_window(&app)
}

/// Drain the pending "open this session" request (set by `open_chats_for_session`
/// when it creates the window). Returns `(session_id, mode)` or null.
#[tauri::command]
pub fn take_pending_chat_open(app: AppHandle) -> Option<(String, String)> {
    let state = app.try_state::<crate::state::AppState>()?;
    let mut pending = state.pending_chat_open.lock().ok()?;
    pending.take()
}

/// Open (or focus) the chats window and tell it to start a new chat for a
/// project with the given model/effort. When the window already exists we emit
/// `chats-new-chat` for its live listener; when it must be created fresh we
/// stash the request in `AppState.pending_new_chat` for the window to drain on
/// boot.
#[tauri::command]
pub fn open_chats_new_chat(
    app: AppHandle,
    project_path: String,
    project_name: String,
    model: String,
    effort: String,
) -> Result<(), String> {
    use tauri::Emitter;
    if let Some(existing) = app.get_webview_window("session-chats") {
        let _ = existing.show();
        existing.set_focus().map_err(|e| e.to_string())?;
        let _ = app.emit(
            "chats-new-chat",
            serde_json::json!({
                "projectPath": project_path,
                "projectName": project_name,
                "model": model,
                "effort": effort,
            }),
        );
        return Ok(());
    }
    if let Some(state) = app.try_state::<crate::state::AppState>() {
        if let Ok(mut pending) = state.pending_new_chat.lock() {
            *pending = Some((project_path, project_name, model, effort));
        }
    }
    build_chats_window(&app)
}

/// Drain the pending "start a new chat" request (set by `open_chats_new_chat`
/// when it creates the window). Returns `(project_path, project_name, model, effort)` or null.
#[tauri::command]
pub fn take_pending_new_chat(app: AppHandle) -> Option<(String, String, String, String)> {
    let state = app.try_state::<crate::state::AppState>()?;
    let mut pending = state.pending_new_chat.lock().ok()?;
    pending.take()
}

/// The model/effort a chat ran with, from the durable chat-config store. Used by
/// the chat-detail view to show effort on a CLOSED chat (live chats read it off
/// the live Instance instead). None for chats that closed before the store
/// existed.
#[tauri::command]
pub fn get_session_config(session_id: String) -> Option<crate::sessions::chat_config::ChatConfig> {
    crate::sessions::chat_config::get(&session_id)
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
pub async fn read_log_file(app: AppHandle) -> Result<String, String> {
    let log_dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    let product = app.package_info().name.clone();
    let log_path = log_dir.join(format!("{product}.log"));
    tauri::async_runtime::spawn_blocking(move || read_log_contents(&log_path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn copy_logs(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let log_dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    let product = app.package_info().name.clone();
    let log_path = log_dir.join(format!("{product}.log"));
    let contents = tauri::async_runtime::spawn_blocking(move || {
        read_log_contents(&log_path).unwrap_or_else(|e| format!("<error reading log: {e}>"))
    })
    .await
    .map_err(|e| e.to_string())?;
    app.clipboard().write_text(contents).map_err(|e| e.to_string())
}

/// Frontend signals it loaded successfully. Watchdog in lib.rs::setup uses
/// this to detect a stalled webview (WebView2 "can't reach this page" error)
/// and trigger a reload. Idempotent; safe to call from every page load.
#[tauri::command]
pub fn frontend_ready(app: AppHandle) {
    use std::sync::atomic::Ordering;
    if let Some(state) = app.try_state::<crate::state::AppState>() {
        state.frontend_alive.store(true, Ordering::SeqCst);
    }
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
    if option_env!("CI").is_none() {
        return "local-build".to_string();
    }
    let cfg = app.config().version.clone();
    cfg.filter(|v| !v.is_empty())
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
}

#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .pick_folder(move |path| {
            let _ = tx.send(path);
        });
    rx.await.unwrap_or(None).map(|p| p.to_string())
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

#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct GitInfo {
    pub branch: Option<String>,
    pub repo: Option<String>,
}

/// Daemon-aligned context-window status for a session. The transcript lives on
/// local disk, so the app resolves it itself (cwd from the mirrored instance
/// cache, else a project-dir scan) and runs the same core scorer the daemon's
/// `/context` endpoint uses. This is the least-coupled option: no daemon RPC,
/// one shared `compute_context_status` for both surfaces. Returns None when the
/// transcript can't be resolved or carries no usage lines.
#[tauri::command]
pub async fn context_status(
    session_id: String,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<Option<crate::context_status::ContextStatus>, String> {
    use crate::tokens::walker;

    // Resolve the transcript path from the app's mirrored instance cache. The
    // daemon registry isn't directly reachable here; `cached_instances` is the
    // app-side mirror refreshed via `instances_changed`.
    let resolved: Option<std::path::PathBuf> = {
        let instances = state.cached_instances.lock().unwrap();
        instances
            .iter()
            .find(|i| i.session_id == session_id)
            .and_then(|inst| {
                inst.transcript_path
                    .as_ref()
                    .filter(|p| p.exists())
                    .cloned()
                    .or_else(|| walker::transcript_for_session(&inst.cwd, &session_id))
            })
    };

    let status = tauri::async_runtime::spawn_blocking(move || {
        if let Some(path) = resolved {
            return crate::context_status::compute_context_status(&path);
        }
        // Fallback: scan ~/.claude/projects/*/<session_id>.jsonl directly.
        let projects = walker::claude_projects_dir()?;
        let target = format!("{session_id}.jsonl");
        let entries = std::fs::read_dir(&projects).ok()?;
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let candidate = dir.join(&target);
            if candidate.exists() {
                return crate::context_status::compute_context_status(&candidate);
            }
        }
        None
    })
    .await
    .map_err(|e| format!("context_status join error: {e}"))?;

    Ok(status)
}

/// Returns the list of files with uncommitted changes in the given directory.
/// Used to detect whether there is work to commit before closing a chat session.
/// Returns an empty vec if the directory is not a git repo or git is unavailable.
#[tauri::command]
pub async fn get_git_dirty(cwd: String) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = std::process::Command::new("git");
        cmd.arg("-C").arg(&cwd).args(["status", "--porcelain"]);
        crate::util::process::hide_console(&mut cmd);
        cmd.output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| {
                s.lines()
                    .filter(|l| l.len() > 3)
                    .map(|l| l[3..].trim().to_string())
                    .filter(|p| !p.is_empty())
                    .collect()
            })
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

/// Returns the current git branch and repository name for the given working
/// directory. Used by the session statusbar to show branch + repo context.
/// Never fails - missing git / no repo / no remote all produce None fields.
///
/// Runs on the blocking pool: spawning `git` is real process IO which
/// must NOT happen on the Tauri runtime thread or the webview UI hangs
/// for the duration of the spawn. On Windows the spawned `git.exe` is
/// flagged CREATE_NO_WINDOW to suppress the otherwise-visible console
/// flash on every chat open.
#[tauri::command]
pub async fn get_git_info(cwd: String) -> GitInfo {
    tauri::async_runtime::spawn_blocking(move || {
        fn run_git(cwd: &str, args: &[&str]) -> Option<String> {
            let mut cmd = std::process::Command::new("git");
            cmd.arg("-C").arg(cwd).args(args);
            crate::util::process::hide_console(&mut cmd);
            cmd.output()
                .ok()
                .filter(|o| o.status.success())
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        }

        let branch = run_git(&cwd, &["branch", "--show-current"]);

        let remote_url = run_git(&cwd, &["remote", "get-url", "origin"]);
        let repo = if let Some(url) = &remote_url {
            url.split('/')
                .last()
                .map(|s| s.trim_end_matches(".git").to_string())
                .filter(|s| !s.is_empty())
        } else {
            std::path::Path::new(&cwd)
                .file_name()
                .and_then(|s| s.to_str())
                .map(|s| s.to_string())
        };

        GitInfo { branch, repo }
    })
    .await
    .unwrap_or(GitInfo { branch: None, repo: None })
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

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let result = rt.block_on(check_paths_exist(vec![
            real.to_string_lossy().to_string(),
            fake.to_string_lossy().to_string(),
        ]));
        assert_eq!(result[&real.to_string_lossy().to_string()], true);
        assert_eq!(result[&fake.to_string_lossy().to_string()], false);
    }
}
