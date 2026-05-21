//! Chat-hub lifecycle + AppHandle / process-tree side IPC. Distinct from
//! `run.rs` (which owns the per-turn IO loop).

use super::attachments::validate_session_id;
use super::ChatState;
use crate::state::AppState;
use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

/// Drain ChatState.running and kill each in-flight runner child. Called
/// from the tray Quit handler so the app doesn't leak claude.exe orphans
/// on exit. No-op if no turns are running.
///
/// Daemon-safe by construction: `ChatState.running` only tracks APP-SIDE
/// Path C runner children. In daemon mode (`useDaemon` on, default since
/// Phase 6) turns run inside the daemon process and are never inserted here,
/// so quitting the app leaves daemon-owned sessions untouched (they survive
/// app close, as designed). Do NOT make this reach into the daemon.
pub fn cancel_all_inflight_turns(app: &AppHandle) {
    let chat_state: tauri::State<'_, Arc<ChatState>> = app.state();
    let pids: Vec<u32> = {
        let mut g = chat_state.running.lock().unwrap();
        let snapshot: Vec<_> = g.drain().collect();
        snapshot
            .into_iter()
            .filter_map(|(_id, slot)| slot.lock().unwrap().take())
            .collect()
    };
    for pid in pids {
        let _ = crate::channels::kill::kill_tree(pid);
    }
}

/// Background GC for chat-attachments older than 30 days. Scheduled once
/// on app startup; re-runs every 24h.
pub async fn gc_attachments() {
    let root = match crate::settings::paths::data_dir() {
        Ok(d) => d.join("chat-attachments"),
        Err(_) => return,
    };
    if !root.exists() {
        return;
    }
    let cutoff = std::time::SystemTime::now()
        - std::time::Duration::from_secs(30 * 24 * 60 * 60);
    let entries = match std::fs::read_dir(&root) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if let Ok(meta) = entry.metadata() {
            if let Ok(modified) = meta.modified() {
                if modified < cutoff {
                    let _ = std::fs::remove_dir_all(&path);
                }
            }
        }
    }
}

/// Open the given chat session in a dedicated Tauri webview window. The
/// window is labeled `session-<session_id>`; if it already exists we just
/// focus it. Closing the window does NOT kill the session - it stays in
/// the registry and can be reattached by clicking the row in the main
/// sidebar.
#[tauri::command]
pub async fn detach_window(session_id: String, app: AppHandle) -> Result<(), String> {
    validate_session_id(&session_id)?;
    let label = format!("session-{}", session_id);
    if let Some(existing) = app.get_webview_window(&label) {
        existing.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let url = format!("index.html#detached?session={}", session_id);
    tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App(url.into()),
    )
    .title(format!(
        "Session {}",
        &session_id[..session_id.len().min(8)]
    ))
    .inner_size(800.0, 600.0)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Close the detached window for `session_id`, if any. Does not kill the
/// session itself.
#[tauri::command]
pub async fn reattach_window(session_id: String, app: AppHandle) -> Result<(), String> {
    validate_session_id(&session_id)?;
    let label = format!("session-{}", session_id);
    if let Some(win) = app.get_webview_window(&label) {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Open the given chat session in an external terminal window, running
/// `claude --resume <session_id>` in the session's cwd. Independent of the
/// Tauri app process - survives app restarts (Path C per-turn model means
/// the claude jsonl is the source of truth; both this app and the external
/// terminal can resume the same session, just not simultaneously).
///
/// Platform behavior:
/// - Windows: prefers Windows Terminal (`wt.exe`); falls back to `cmd.exe`.
/// - macOS: `osascript` driving Terminal.app.
/// - Linux: tries `gnome-terminal`, `konsole`, `xterm` in order.
#[tauri::command]
pub async fn open_session_in_terminal(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    validate_session_id(&session_id)?;
    let entry = state
        .cached_instances
        .lock()
        .unwrap()
        .iter()
        .find(|i| i.session_id == session_id)
        .cloned()
        .ok_or_else(|| format!("session {session_id} not found in registry"))?;
    let cwd = entry.cwd.clone();
    if !cwd.exists() {
        return Err(format!("cwd does not exist: {}", cwd.display()));
    }
    spawn_terminal_for_session(&session_id, &cwd).map_err(|e| e.to_string())?;
    let guard = state.daemon_client.lock().await;
    if let Some(client) = guard.as_ref() {
        let _ = client.externalize_session(&session_id).await;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn spawn_terminal_for_session(
    session_id: &str,
    cwd: &std::path::Path,
) -> std::io::Result<()> {
    use std::process::Command;
    let cwd_str = cwd.to_string_lossy().to_string();
    // Try Windows Terminal first.
    let wt_result = Command::new("wt.exe")
        .args([
            "-d",
            &cwd_str,
            "cmd.exe",
            "/K",
            &format!("claude --resume {session_id}"),
        ])
        .spawn();
    if wt_result.is_ok() {
        return Ok(());
    }
    // Fall back to bare cmd.exe in a new console window.
    Command::new("cmd.exe")
        .arg("/C")
        .arg("start")
        .arg("")
        .arg("cmd.exe")
        .arg("/K")
        .arg(format!("claude --resume {session_id}"))
        .current_dir(cwd)
        .spawn()?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn spawn_terminal_for_session(
    session_id: &str,
    cwd: &std::path::Path,
) -> std::io::Result<()> {
    use std::process::Command;
    // AppleScript escaping: backslash + double-quotes.
    let cwd_esc = cwd.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\"");
    let id_esc = session_id.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        "tell application \"Terminal\" to do script \"cd \\\"{cwd_esc}\\\" && claude --resume {id_esc}\""
    );
    Command::new("osascript").arg("-e").arg(&script).spawn()?;
    // Bring Terminal.app forward.
    let _ = Command::new("osascript")
        .arg("-e")
        .arg("tell application \"Terminal\" to activate")
        .spawn();
    Ok(())
}

#[cfg(target_os = "linux")]
fn spawn_terminal_for_session(
    session_id: &str,
    cwd: &std::path::Path,
) -> std::io::Result<()> {
    use std::process::Command;
    let cwd_str = cwd.to_string_lossy().to_string();
    let candidates: &[(&str, &[&str])] = &[
        ("gnome-terminal", &["--working-directory"]),
        ("konsole", &["--workdir"]),
        ("xfce4-terminal", &["--working-directory"]),
        ("xterm", &[]),
    ];
    for (bin, dir_flag) in candidates {
        let mut cmd = Command::new(bin);
        match bin {
            &"gnome-terminal" => {
                cmd.arg(format!("{}={}", dir_flag[0], cwd_str))
                    .arg("--")
                    .arg("bash")
                    .arg("-c")
                    .arg(format!("claude --resume {session_id}; exec bash"));
            }
            &"konsole" => {
                cmd.arg(dir_flag[0])
                    .arg(&cwd_str)
                    .arg("-e")
                    .arg("bash")
                    .arg("-c")
                    .arg(format!("claude --resume {session_id}; exec bash"));
            }
            &"xfce4-terminal" => {
                cmd.arg(format!("{}={}", dir_flag[0], cwd_str))
                    .arg("-e")
                    .arg(format!("bash -c 'claude --resume {session_id}; exec bash'"));
            }
            _ => {
                cmd.current_dir(cwd)
                    .arg("-e")
                    .arg("bash")
                    .arg("-c")
                    .arg(format!("claude --resume {session_id}; exec bash"));
            }
        }
        if cmd.spawn().is_ok() {
            return Ok(());
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "no supported terminal emulator found (tried gnome-terminal, konsole, xfce4-terminal, xterm)",
    ))
}

/// Promote a Manual (External) session to Interactive. Kills the external
/// claude process so this app's per-turn `--resume` calls don't race the
/// external one for JSONL writes. Returns the session_id of the now-Interactive
/// entry; the frontend switches the chat pane to bind to it.
#[tauri::command]
pub async fn takeover_manual(
    manual_pid: u32,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let (model, effort) = resolve_takeover_model_effort(manual_pid, &state);
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client.takeover_manual(manual_pid, &model, &effort).await.map_err(|e| e.to_string())
}

/// Resolve model+effort for takeover from settings.extra:
/// 1. projectLastChoice[cwd_path] -> {model, effort}
/// 2. effortPresets[].name == "Normal" -> {model, effort}
/// 3. fall back to ("opus", "high")
fn resolve_takeover_model_effort(manual_pid: u32, state: &AppState) -> (String, String) {
    let entry = state
        .cached_instances
        .lock()
        .unwrap()
        .iter()
        .find(|i| i.pid == manual_pid)
        .cloned();
    let cwd_key = entry
        .map(|e| e.cwd.to_string_lossy().to_string())
        .unwrap_or_default();

    let settings = state.settings.lock().unwrap();
    let extra = &settings.extra;

    // 1. projectLastChoice[cwd_key]
    if !cwd_key.is_empty() {
        if let Some(map) = extra.get("projectLastChoice").and_then(|v| v.as_object()) {
            if let Some(choice) = map.get(&cwd_key).and_then(|v| v.as_object()) {
                let model = choice.get("model").and_then(|v| v.as_str()).unwrap_or("");
                let effort = choice.get("effort").and_then(|v| v.as_str()).unwrap_or("");
                if !model.is_empty() && !effort.is_empty() {
                    return (model.to_string(), effort.to_string());
                }
            }
        }
    }

    // 2. Normal preset
    if let Some(arr) = extra.get("effortPresets").and_then(|v| v.as_array()) {
        for p in arr {
            let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if name == "Normal" {
                let model = p.get("model").and_then(|v| v.as_str()).unwrap_or("");
                let effort = p.get("effort").and_then(|v| v.as_str()).unwrap_or("");
                if !model.is_empty() && !effort.is_empty() {
                    return (model.to_string(), effort.to_string());
                }
            }
        }
    }

    // 3. fallback
    ("opus".to_string(), "high".to_string())
}

/// Respond to a pending permission request from the MCP server.
/// Looks up the oneshot sender in the shared pending map and resolves it.
///
/// Per Claude Code's `--permission-prompt-tool` contract, the resolved JSON
/// MUST match one of:
///   - `{"behavior": "allow", "updatedInput": <object>}` — updatedInput is
///     the (possibly modified) tool input. Claude rejects `null` here.
///   - `{"behavior": "deny", "message": <string>}` — message is shown to
///     claude as the rejection reason; required (validation error if missing).
///
/// For question-shaped permissions (AskUserQuestion / ask_user_question) the
/// frontend uses `behavior: "deny"` + `message` to relay the user's chosen
/// answer back to claude as text, since headless `claude -p` has no native
/// way to receive structured answers from the built-in tool.
#[tauri::command]
pub async fn respond_permission(
    id: String,
    behavior: String,
    updated_input: Option<Value>,
    message: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let allow = match behavior.as_str() {
        "allow" => true,
        "deny" => false,
        _ => return Err(format!("invalid behavior: {behavior:?} (must be 'allow' or 'deny')")),
    };
    let client_guard = state.daemon_client.lock().await;
    let client = client_guard
        .as_ref()
        .ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .respond_permission(
            &id,
            allow,
            if allow { Some(updated_input.unwrap_or_else(|| serde_json::json!({}))) } else { None },
            if allow { None } else { Some(message.unwrap_or_else(|| "Denied by user.".to_string())) },
        )
        .await
        .map_err(|e| e.to_string())
}

/// Respond to a pending question request from the MCP server.
#[tauri::command]
pub async fn respond_question(
    id: String,
    answers: Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let client_guard = state.daemon_client.lock().await;
    let client = client_guard
        .as_ref()
        .ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .respond_question(&id, answers)
        .await
        .map_err(|e| e.to_string())
}
