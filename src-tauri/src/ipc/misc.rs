use serde::Serialize;
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
    // Hide on close instead of destroying, mirroring the main window's
    // hide-to-tray. A destroyed window means every reopen is a cold webview
    // boot ("Setting up..." each time); a hidden one reopens instantly with
    // its state intact. Real quit (tray menu) sets should_quit and passes.
    {
        let w = window.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                use std::sync::atomic::Ordering;
                let quitting = w
                    .app_handle()
                    .try_state::<crate::state::AppState>()
                    .map(|s| s.should_quit.load(Ordering::SeqCst))
                    .unwrap_or(false);
                if quitting {
                    return;
                }
                api.prevent_close();
                let _ = w.hide();
            }
        });
    }
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

#[derive(Serialize)]
pub struct VersionInfo {
    pub version: String,
    pub build_date: String,
    pub installed_at: Option<String>,
}

#[tauri::command]
pub fn get_version_info(app: AppHandle) -> VersionInfo {
    let version = get_app_version(app);
    let build_date = option_env!("BUILD_DATE").unwrap_or("unknown").to_string();
    let installed_at = load_or_record_install_date(&version);
    VersionInfo { version, build_date, installed_at }
}

fn load_or_record_install_date(current_version: &str) -> Option<String> {
    #[derive(serde::Deserialize, serde::Serialize)]
    struct InstallInfo { version: String, installed_at: String }

    let dir = crate::settings::paths::data_dir().ok()?;
    let path = dir.join("install-info.json");

    if let Ok(content) = std::fs::read_to_string(&path) {
        if let Ok(info) = serde_json::from_str::<InstallInfo>(&content) {
            if info.version == current_version {
                return Some(info.installed_at);
            }
        }
    }

    let today = today_date_string();
    let info = InstallInfo { version: current_version.to_string(), installed_at: today.clone() };
    if let Ok(json) = serde_json::to_string(&info) {
        let _ = std::fs::write(&path, json);
    }
    Some(today)
}

fn today_date_string() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let (y, m, d) = epoch_secs_to_ymd(secs);
    format!("{y:04}-{m:02}-{d:02}")
}

fn epoch_secs_to_ymd(secs: u64) -> (u64, u64, u64) {
    let z = secs / 86400 + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
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
pub async fn create_folder(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    #[allow(deprecated)]
    app.shell().open(url, None).map_err(|e| e.to_string())
}

/// Open a file path in VS Code. Spawns detached (never waits on the child).
///
/// On Windows VS Code's CLI is `code.cmd`, so `Command::new("code")` won't
/// resolve - we go through `cmd /C code <path>` with CREATE_NO_WINDOW
/// (via `hide_console`) so no console window flashes (a known freeze/flicker
/// source in this app). If `code` can't be spawned we fall back to the OS
/// default handler via the same `tauri-plugin-shell` mechanism `open_external`
/// uses to open URLs/paths.
#[tauri::command]
pub async fn open_in_editor(app: AppHandle, path: String) -> Result<(), String> {
    use std::process::Command;

    let spawned = {
        #[cfg(target_os = "windows")]
        {
            let mut cmd = Command::new("cmd");
            cmd.args(["/C", "code", &path]);
            crate::util::process::hide_console(&mut cmd);
            cmd.spawn().is_ok()
        }
        #[cfg(not(target_os = "windows"))]
        {
            Command::new("code").arg(&path).spawn().is_ok()
        }
    };

    if spawned {
        return Ok(());
    }

    // VS Code not found / spawn failed - fall back to the OS default handler,
    // mirroring `open_external`.
    use tauri_plugin_shell::ShellExt;
    #[allow(deprecated)]
    app.shell().open(path, None).map_err(|e| e.to_string())
}

/// Read an arbitrary local image file as `{mime, base64}` for an in-app
/// lightbox. Unlike `read_attachment` (which is sandboxed to the
/// chat-attachments directory), this reads any absolute path the agent
/// surfaced - e.g. a `.png` the model Read. MIME is inferred from the
/// extension; unknown extensions fall back to `application/octet-stream`.
#[tauri::command]
pub async fn read_image_file(
    path: String,
) -> Result<crate::ipc::chat::attachments::AttachmentData, String> {
    use base64::Engine;
    let target = std::path::PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| format!("file not found: {e}"))?;
    let bytes = std::fs::read(&target).map_err(|e| e.to_string())?;
    let mime = match target.extension().and_then(|e| e.to_str()) {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    }
    .to_string();
    let base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(crate::ipc::chat::attachments::AttachmentData { mime, base64 })
}


#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct GitInfo {
    pub branch: Option<String>,
    pub repo: Option<String>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub sha: Option<String>,
    pub insertions: Option<u32>,
    pub deletions: Option<u32>,
}

/// Parse `git diff --shortstat` output into (insertions, deletions). Empty
/// output (clean tree) => (None, None); a present line with only one side =>
/// the missing side is 0.
pub fn parse_shortstat(s: &str) -> (Option<u32>, Option<u32>) {
    let s = s.trim();
    if s.is_empty() {
        return (None, None);
    }
    let grab = |needle: &str| -> Option<u32> {
        let idx = s.find(needle)?;
        s[..idx]
            .rsplit(|c: char| !c.is_ascii_digit())
            .find(|p| !p.is_empty())
            .and_then(|p| p.parse().ok())
    };
    (Some(grab("insertion").unwrap_or(0)), Some(grab("deletion").unwrap_or(0)))
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

        // Upstream ahead/behind: `behind<TAB>ahead`. None when no upstream.
        let (ahead, behind) = run_git(&cwd, &["rev-list", "--left-right", "--count", "@{u}...HEAD"])
            .and_then(|s| {
                let mut it = s.split_whitespace();
                let behind = it.next()?.parse::<u32>().ok()?;
                let ahead = it.next()?.parse::<u32>().ok()?;
                Some((Some(ahead), Some(behind)))
            })
            .unwrap_or((None, None));

        let sha = run_git(&cwd, &["rev-parse", "--short", "HEAD"]);

        let (insertions, deletions) = run_git(&cwd, &["diff", "--shortstat"])
            .map(|s| parse_shortstat(&s))
            .unwrap_or((None, None));

        GitInfo { branch, repo, ahead, behind, sha, insertions, deletions }
    })
    .await
    .unwrap_or(GitInfo { branch: None, repo: None, ahead: None, behind: None, sha: None, insertions: None, deletions: None })
}

#[cfg(test)]
mod git_info_tests {
    use super::parse_shortstat;

    #[test]
    fn parses_insertions_and_deletions() {
        assert_eq!(parse_shortstat(" 3 files changed, 42 insertions(+), 7 deletions(-)"), (Some(42), Some(7)));
    }
    #[test]
    fn parses_insertions_only() {
        assert_eq!(parse_shortstat(" 1 file changed, 5 insertions(+)"), (Some(5), Some(0)));
    }
    #[test]
    fn parses_deletions_only() {
        assert_eq!(parse_shortstat(" 1 file changed, 9 deletions(-)"), (Some(0), Some(9)));
    }
    #[test]
    fn empty_is_none() {
        assert_eq!(parse_shortstat(""), (None, None));
    }
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

/// Fetch the list of model IDs the signed-in account can use via the
/// Anthropic /v1/models endpoint, authenticated with the Claude OAuth token
/// stored in ~/.claude/.credentials.json.
///
/// Returns the raw list of model id strings newest-first as the API delivers
/// them. Curation (latest-per-family) and merge with user settings happen on
/// the frontend. Fails silently on any error (file missing, bad JSON, network
/// error, non-200, parse failure) and returns an empty vec, so a cold boot
/// while offline never breaks the model picker.
#[tauri::command]
pub async fn fetch_available_models() -> Vec<String> {
    match fetch_available_models_inner().await {
        Ok(models) => models,
        Err(e) => {
            log::debug!("fetch_available_models: {e}");
            vec![]
        }
    }
}

async fn fetch_available_models_inner() -> anyhow::Result<Vec<String>> {
    let home = dirs::home_dir().ok_or_else(|| anyhow::anyhow!("no home dir"))?;
    let creds_path = home.join(".claude").join(".credentials.json");
    let raw = std::fs::read_to_string(&creds_path)
        .map_err(|e| anyhow::anyhow!("read credentials: {e}"))?;
    let creds: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| anyhow::anyhow!("parse credentials: {e}"))?;
    let token = creds
        .get("claudeAiOauth")
        .and_then(|o| o.get("accessToken"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("no claudeAiOauth.accessToken in credentials"))?
        .to_string();

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()?;
    let resp = client
        .get("https://api.anthropic.com/v1/models")
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await?
        .error_for_status()?;
    let body: serde_json::Value = resp.json().await?;
    let ids = body
        .get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.get("id").and_then(|v| v.as_str()).map(String::from))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(ids)
}

/// Read the Claude OAuth access token from ~/.claude/.credentials.json.
fn read_claude_oauth_token() -> anyhow::Result<String> {
    let home = dirs::home_dir().ok_or_else(|| anyhow::anyhow!("no home dir"))?;
    let creds_path = home.join(".claude").join(".credentials.json");
    let raw = std::fs::read_to_string(&creds_path)
        .map_err(|e| anyhow::anyhow!("read credentials: {e}"))?;
    let creds: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| anyhow::anyhow!("parse credentials: {e}"))?;
    creds
        .get("claudeAiOauth")
        .and_then(|o| o.get("accessToken"))
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| anyhow::anyhow!("no claudeAiOauth.accessToken in credentials"))
}

/// Probe whether each given model id is actually usable by the signed-in
/// account.
///
/// The /v1/models listing is NOT a reliable availability signal: it keeps
/// listing models (e.g. Fable 5) even after Anthropic disables them. The free
/// /v1/messages/count_tokens endpoint, by contrast, returns 404
/// not_found_error for a disabled model, so we use it as a zero-cost probe — it
/// only counts tokens, it never generates, so it is never billed.
///
/// Returns a JSON array of `{ id, available, message }`. `message` carries the
/// API's explanation when a model is unavailable (e.g. "Claude Fable 5 is not
/// available. Please use Opus 4.8."), null otherwise. Any error on our side (no
/// credentials, network failure) is treated as available=true so a transient
/// failure never wrongly blocks the picker.
#[tauri::command]
pub async fn probe_models_availability(models: Vec<String>) -> serde_json::Value {
    let all_available = |models: Vec<String>| {
        serde_json::Value::Array(
            models
                .into_iter()
                .map(|id| serde_json::json!({ "id": id, "available": true, "message": null }))
                .collect(),
        )
    };

    let token = match read_claude_oauth_token() {
        Ok(t) => t,
        Err(e) => {
            log::debug!("probe_models_availability: {e}");
            return all_available(models);
        }
    };
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            log::debug!("probe_models_availability: {e}");
            return all_available(models);
        }
    };

    let probes = models.into_iter().map(|id| {
        let client = client.clone();
        let token = token.clone();
        async move {
            let (available, message) = probe_one_model(&client, &token, &id).await;
            serde_json::json!({ "id": id, "available": available, "message": message })
        }
    });
    serde_json::Value::Array(futures_util::future::join_all(probes).await)
}

/// Single count_tokens probe. Returns (available, optional API message). On any
/// transport error we fail open (available=true) so we never block on a blip.
async fn probe_one_model(
    client: &reqwest::Client,
    token: &str,
    model: &str,
) -> (bool, Option<String>) {
    let body = serde_json::json!({
        "model": model,
        "messages": [{ "role": "user", "content": "hi" }],
    });
    let resp = match client
        .post("https://api.anthropic.com/v1/messages/count_tokens")
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return (true, None),
    };
    if resp.status().is_success() {
        return (true, None);
    }
    let message = resp
        .json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|v| {
            v.get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .map(String::from)
        });
    (false, message)
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
