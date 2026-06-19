use serde::Serialize;
use tauri::{AppHandle, Manager};

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

    // UTC date string (matches the prior hand-rolled epoch->YMD math, which also
    // worked off UNIX_EPOCH seconds). chrono is already a crate dependency.
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let info = InstallInfo { version: current_version.to_string(), installed_at: today.clone() };
    if let Ok(json) = serde_json::to_string(&info) {
        let _ = std::fs::write(&path, json);
    }
    Some(today)
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


/// Max bytes `read_text_file` returns. Files larger than this are returned
/// truncated (capped prefix + `truncated: true`) so the in-app read-only file
/// viewer never tries to highlight a multi-megabyte blob. Mirrors the spirit
/// of `read_image_file` (which reads any absolute path the agent surfaced).
const TEXT_FILE_CAP_BYTES: usize = 2 * 1024 * 1024; // 2 MB

#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct TextFileData {
    pub content: String,
    pub truncated: bool,
}

/// Read an arbitrary local text file for the in-app read-only file viewer.
/// Like `read_image_file`, this reads any absolute path the agent surfaced
/// (not sandboxed). The read is capped at `TEXT_FILE_CAP_BYTES`: a larger file
/// yields the capped prefix with `truncated: true`. Decoding is lossy UTF-8 so
/// binary-ish files produce replacement characters instead of panicking.
#[tauri::command]
pub async fn read_text_file(path: String) -> Result<TextFileData, String> {
    use std::io::Read;
    tauri::async_runtime::spawn_blocking(move || {
        let target = std::path::PathBuf::from(&path)
            .canonicalize()
            .map_err(|e| format!("file not found: {e}"))?;
        let file = std::fs::File::open(&target).map_err(|e| e.to_string())?;
        // Read one byte past the cap so we can tell "exactly at cap" from
        // "larger than cap".
        let mut buf = Vec::new();
        file.take((TEXT_FILE_CAP_BYTES + 1) as u64)
            .read_to_end(&mut buf)
            .map_err(|e| e.to_string())?;
        let truncated = buf.len() > TEXT_FILE_CAP_BYTES;
        if truncated {
            buf.truncate(TEXT_FILE_CAP_BYTES);
        }
        let content = String::from_utf8_lossy(&buf).into_owned();
        Ok(TextFileData { content, truncated })
    })
    .await
    .map_err(|e| format!("read_text_file join error: {e}"))?
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
