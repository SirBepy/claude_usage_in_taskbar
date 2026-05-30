//! App-side daemon link: the startup task that connects to the daemon, seeds
//! caches from its snapshot, and routes daemon notifications into Tauri events,
//! plus the reconnect loop. Extracted from `lib.rs` (ai_todo 76); pure move, no
//! behavior change.

use tauri::Manager;

/// Spawned once at startup. Connect-or-spawn the daemon (via `ensure_daemon`),
/// push settings, subscribe for notifications, seed the instance/channel caches
/// from the daemon snapshot, then pump notifications. On connection loss it
/// respawns + reconnects with capped backoff. The transport is a named pipe on
/// Windows and a Unix socket on macOS/Linux; channel automation stays
/// Windows-only (see `daemon::channel_adopt`).
pub async fn run_app_subscription(app_handle: tauri::AppHandle) {
    let state = app_handle.state::<crate::state::AppState>();
    {
        // Reconnect loop: on connection loss, respawn the daemon
        // (via ensure_daemon) + reconnect with capped backoff, then
        // re-subscribe + re-seed caches.
        let mut backoff_ms: u64 = 500;
        loop {
            let client = match crate::daemon_client::ensure_daemon().await {
                Ok(c) => c,
                Err(e) => {
                    log::error!("daemon connect failed: {e}; retrying in {backoff_ms}ms");
                    tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
                    backoff_ms = (backoff_ms * 2).min(8000);
                    continue;
                }
            };
            backoff_ms = 500;
            // Push initial settings BEFORE subscribing so the daemon's cache is
            // populated before any incoming hook traffic.
            let settings_snapshot = state.settings.lock().unwrap().clone();
            if let Err(e) = client.push_settings(&settings_snapshot).await {
                log::error!("push_settings failed: {e}");
            }
            let mut rx = match client.subscribe_global().await {
                Ok(rx) => rx,
                Err(e) => {
                    log::error!("subscribe_global failed: {e}; reconnecting");
                    tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
                    continue;
                }
            };
            // Seed the caches from the daemon's current snapshot so
            // already-running sessions/channels render immediately on
            // connect, instead of waiting for the next change event
            // (ai_todo 63). The frontend's `instances-changed` /
            // `channels-changed` listeners re-read the caches.
            {
                use tauri::Emitter;
                if let Ok(instances) = client.list_instances().await {
                    if let Ok(parsed) = serde_json::from_value::<Vec<crate::types::Instance>>(instances.clone()) {
                        *state.cached_instances.lock().unwrap() = parsed;
                        let _ = app_handle.emit("instances-changed", instances);
                    }
                }
                if let Ok(channels) = client.list_channels().await {
                    if let Some(arr) = channels.as_array() {
                        *state.cached_channels.lock().unwrap() = arr.clone();
                        let _ = app_handle.emit("channels-changed", channels);
                    }
                }
            }
            {
                let mut slot = state.daemon_client.lock().await;
                *slot = Some(client);
            }
            while let Some(frame) = rx.recv().await {
                let method = frame.get("method").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let params = frame.get("params").cloned().unwrap_or(serde_json::Value::Null);
                handle_daemon_notification(&app_handle, &method, params).await;
            }
            log::warn!("daemon connection lost; respawning + reconnecting");
            { *state.daemon_client.lock().await = None; }
        }
    }
}

/// Given the set of currently-attached session ids and the latest instance
/// snapshot, return the attached ids that should be detached: those that have
/// ended (`ended_at` set) or have vanished from the snapshot entirely. Used to
/// stop the per-session bridge pump when a session ends (ai_todo 66 #2).
fn stale_attached_sessions(
    attached: &std::collections::HashSet<String>,
    instances: &[crate::types::Instance],
) -> Vec<String> {
    let live: std::collections::HashSet<&str> = instances
        .iter()
        .filter(|i| i.ended_at.is_none())
        .map(|i| i.session_id.as_str())
        .collect();
    attached
        .iter()
        .filter(|id| !live.contains(id.as_str()))
        .cloned()
        .collect()
}

/// Routes daemon-side notifications into app-side Tauri events + cache updates.
async fn handle_daemon_notification(app: &tauri::AppHandle, method: &str, params: serde_json::Value) {
    use tauri::{Emitter, Manager};
    match method {
        "instances_changed" => {
            let state = app.state::<crate::state::AppState>();
            if let Some(instances) = params.get("instances").cloned() {
                if let Ok(parsed) = serde_json::from_value::<Vec<crate::types::Instance>>(instances.clone()) {
                    // Detach any attached session that just ended/vanished so its
                    // bridge pump task exits instead of leaking (ai_todo 66 #2).
                    // Collect under the sync lock, then release it BEFORE awaiting.
                    let stale = {
                        let attached = state.attached_sessions.lock().unwrap();
                        stale_attached_sessions(&attached, &parsed)
                    };
                    if !stale.is_empty() {
                        let guard = state.daemon_client.lock().await;
                        if let Some(client) = guard.as_ref() {
                            for id in &stale {
                                let _ = client.detach_session(id).await;
                            }
                        }
                    }
                    *state.cached_instances.lock().unwrap() = parsed;
                    // Deferred window close: if the user clicked X while instances
                    // were busy, hide the window once they all go idle.
                    {
                        use std::sync::atomic::Ordering;
                        if state.pending_close.load(Ordering::SeqCst) {
                            let any_busy = state.cached_instances.lock().unwrap()
                                .iter().any(|i| i.busy);
                            if !any_busy {
                                state.pending_close.store(false, Ordering::SeqCst);
                                let h = app.clone();
                                let _ = app.run_on_main_thread(move || {
                                    if let Some(win) = h.get_webview_window("main") {
                                        let _ = win.eval("window.navigateTo && window.navigateTo('dashboard')");
                                        let _ = win.hide();
                                    }
                                    crate::tray::menu::render_tray_now(&h);
                                });
                            }
                        }
                    }
                }
                let _ = app.emit("instances-changed", instances);
            }
        }
        "channels_changed" => {
            let state = app.state::<crate::state::AppState>();
            // params is the channel-snapshot JSON array (see daemon::channels::emit_changed).
            if let Some(arr) = params.as_array() {
                let mut cache = state.cached_channels.lock().unwrap();
                *cache = arr.clone();
            }
            let _ = app.emit("channels-changed", params);
        }
        "permission_request" => { let _ = app.emit("permission-requested", params); }
        "question_request" => { let _ = app.emit("question-requested", params); }
        "token_history_updated" => {
            if let Some(h) = params.get("history") {
                let _ = app.emit("token-history-updated", h);
            }
        }
        "skill_usage_changed" => { let _ = app.emit("skill-usage-changed", serde_json::json!({})); }
        "refresh_requested" => {
            let app2 = app.clone();
            let cwd = params.get("cwd").and_then(|v| v.as_str()).map(|s| s.to_string());
            tokio::spawn(async move {
                let _ = crate::scheduler::poll_once(&app2, crate::scheduler::PollTrigger::Hook).await;
                let name = cwd.as_deref().and_then(crate::notifications::project_name_from_cwd);
                crate::notifications::fire(
                    &app2,
                    crate::notifications::NotifKind::WorkFinished,
                    crate::notifications::NotifContext { name, percent: None },
                    cwd.as_deref(),
                );
            });
        }
        "notify_requested" => {
            let cwd = params.get("cwd").and_then(|v| v.as_str()).map(|s| s.to_string());
            let name = cwd.as_deref().and_then(crate::notifications::project_name_from_cwd);
            crate::notifications::fire(
                app,
                crate::notifications::NotifKind::QuestionAsked,
                crate::notifications::NotifContext { name, percent: None },
                cwd.as_deref(),
            );
        }
        "quit_requested" => {
            app.exit(0);
        }
        "project_created" => {
            if let (Some(project_id), Some(cwd), Some(now)) = (
                params.get("project_id").and_then(|v| v.as_str()),
                params.get("cwd").and_then(|v| v.as_str()),
                params.get("now").and_then(|v| v.as_str()),
            ) {
                let state = app.state::<crate::state::AppState>();
                let mut settings_guard = state.settings.lock().unwrap();
                crate::settings::upsert_project_with_id_for_cwd(
                    &mut settings_guard,
                    project_id,
                    &std::path::PathBuf::from(cwd),
                    now,
                );
                let snapshot = settings_guard.clone();
                drop(settings_guard);
                if let Ok(path) = crate::settings::paths::settings_file() {
                    let _ = crate::settings::save(&path, &snapshot);
                }
                let _ = app.emit("settings-changed", &snapshot);
            }
        }
        other => {
            log::debug!("daemon notif ignored: {other}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::stale_attached_sessions;
    use crate::sessions::kinds::InstanceKind;
    use crate::types::Instance;
    use std::collections::HashSet;

    fn instance(session_id: &str, ended: bool) -> Instance {
        Instance {
            session_id: session_id.to_string(),
            pid: 0,
            cwd: std::path::PathBuf::from("C:/x"),
            project_id: "proj".into(),
            kind: InstanceKind::Interactive,
            is_remote: false,
            started_at: "2026-05-22T00:00:00Z".into(),
            transcript_path: None,
            bridge_session_id: None,
            name: None,
            ended_at: if ended { Some("2026-05-22T00:00:01Z".to_string()) } else { None },
            end_reason: None,
            busy: false,
            model: String::new(),
            effort: String::new(),
        }
    }

    fn attached(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn live_attached_session_is_not_stale() {
        let stale = stale_attached_sessions(&attached(&["a"]), &[instance("a", false)]);
        assert!(stale.is_empty());
    }

    #[test]
    fn ended_attached_session_is_stale() {
        let stale = stale_attached_sessions(&attached(&["a"]), &[instance("a", true)]);
        assert_eq!(stale, vec!["a".to_string()]);
    }

    #[test]
    fn vanished_attached_session_is_stale() {
        // Attached id no longer present in the snapshot at all.
        let stale = stale_attached_sessions(&attached(&["a"]), &[instance("b", false)]);
        assert_eq!(stale, vec!["a".to_string()]);
    }

    #[test]
    fn unattached_ended_session_is_ignored() {
        // We only detach sessions we are actually attached to.
        let stale = stale_attached_sessions(&attached(&[]), &[instance("a", true)]);
        assert!(stale.is_empty());
    }
}
