pub mod audio;
pub mod channels;
pub mod hook_installer;
pub mod auth;
pub mod detector;
pub mod project_overrides;
pub mod display_state;
pub mod fonts;
pub mod icon_settings;
pub mod notifications;
pub mod soundpacks;
pub mod piper;
pub mod usage_parser;
pub mod cdp;
pub mod history;
pub mod hook_server;
pub mod instances;
pub mod icon;
pub mod ipc;
pub mod paths;
pub mod scheduler;
pub mod scraper;
pub mod session;
pub mod session_files;
pub mod settings;
pub mod state;
pub mod token_stats;
pub mod tray;
pub mod types;
pub mod vault_detector;

use crate::state::AppState;
use crate::types::AuthState;
use tauri::Emitter;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = paths::ensure_data_dir();
    let settings_path = paths::settings_file().expect("settings path");
    let session_path = paths::session_file().expect("session path");
    let loaded_settings = settings::load(&settings_path);
    let auth = if session::load(&session_path).is_some() {
        AuthState::LoggedIn
    } else {
        AuthState::NeedsLogin
    };

    let state = AppState::new(loaded_settings, auth);

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .level_for("claude_usage_tauri_lib", log::LevelFilter::Debug)
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_shell::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            ipc::get_current_usage,
            ipc::get_history,
            ipc::get_settings,
            ipc::save_settings,
            ipc::auth_status,
            ipc::open_dashboard,
            ipc::quit_app,
            ipc::logout,
            ipc::poll_now,
            ipc::start_login,
            ipc::read_log_file,
            ipc::get_token_history,
            ipc::get_active_sessions,
            ipc::backfill_transcripts,
            ipc::check_paths_exist,
            ipc::open_in_explorer,
            ipc::open_in_vscode,
            ipc::piper_status,
            ipc::piper_install_voice,
            ipc::piper_speak_preview,
            ipc::play_sound_preview,
            ipc::play_pack_sound_preview,
            ipc::copy_logs,
            ipc::get_platform,
            ipc::get_app_version,
            ipc::open_external,
            ipc::check_for_updates,
            ipc::download_and_install_update,
            ipc::install_update,
            ipc::get_update_state,
            ipc::list_sound_packs,
            ipc::install_sound_pack,
            ipc::sound_pack_file_url,
            ipc::list_projects,
            ipc::get_project,
            ipc::ensure_project,
            ipc::update_project,
            ipc::delete_project,
            ipc::set_projects_view_mode,
            ipc::spawn_channel,
            ipc::stop_channel,
            ipc::restart_channel,
            ipc::show_terminal,
            ipc::hide_terminal,
            ipc::list_channels,
            ipc::detect_obsidian_vaults,
            ipc::import_legacy_obsidian_config,
            ipc::confirm_legacy_obsidian_import,
            ipc::list_instances,
            ipc::list_instances_for_project,
            ipc::phone_link,
            ipc::instance_token_stats,
            ipc::get_hook_registration_state,
            ipc::register_hooks_globally,
            ipc::skip_hook_registration,
        ])
        .setup(|app| {
            log::info!("claude-usage-tauri started");
            crate::tray::setup(app.handle())?;
            {
                use tauri_plugin_autostart::ManagerExt;
                let autostart_mgr = app.autolaunch();
                let state = app.state::<crate::state::AppState>();
                let desired = state.settings.lock().unwrap().autostart;
                let _ = if desired {
                    autostart_mgr.enable()
                } else {
                    autostart_mgr.disable()
                };
            }
            {
                use tauri::Listener;
                let h = app.handle().clone();
                app.listen("settings-changed", move |event| {
                    use tauri_plugin_autostart::ManagerExt;
                    let Ok(settings) = serde_json::from_str::<crate::types::Settings>(event.payload()) else { return; };
                    let mgr = h.autolaunch();
                    let _ = if settings.autostart { mgr.enable() } else { mgr.disable() };
                });
            }
            {
                use tauri::Manager;
                let auto = app.state::<crate::state::AppState>().settings.lock().unwrap().auto_update;
                if auto {
                    let h = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = check_updater(&h).await;
                        loop {
                            tokio::time::sleep(std::time::Duration::from_secs(6 * 3600)).await;
                            use tauri::Manager;
                            let still = h.state::<crate::state::AppState>().settings.lock().unwrap().auto_update;
                            if !still { break; }
                            let _ = check_updater(&h).await;
                        }
                    });
                }
            }
            crate::scheduler::spawn(app.handle().clone());

            // Auto-backfill token history once, off the main thread. Keeps
            // the stats page populated on first launch / after new sessions.
            {
                let h = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let Ok(path) = paths::token_history_file() else { return };
                    let path_clone = path.clone();
                    match tauri::async_runtime::spawn_blocking(move || {
                        crate::token_stats::backfill_all(&path_clone)
                    })
                    .await
                    {
                        Ok(Ok(r)) => {
                            log::info!(
                                "startup backfill: {} new, {} skipped (sub: {} new, {} skipped)",
                                r.processed, r.skipped, r.sub_processed, r.sub_skipped
                            );
                            let history = crate::token_stats::load_history(&path);
                            let _ = h.emit("token-history-updated", history);
                        }
                        Ok(Err(e)) => log::warn!("startup backfill failed: {e:?}"),
                        Err(e) => log::warn!("startup backfill join error: {e}"),
                    }
                });
            }
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = crate::hook_server::spawn(handle.clone()).await {
                    log::error!("hook server spawn failed: {e}");
                    return;
                }
                migrate_hook_install_if_needed(&handle);
            });
            {
                let h = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    rehydrate_instances_from_session_files(&h);
                    crate::detector::run(h).await
                });
            }
            {
                let h = app.handle().clone();
                tauri::async_runtime::spawn(async move { crate::channels::autostart_all(h).await });
            }
            if let Some(window) = app.get_webview_window("main") {
                let w = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = w.hide();
                    }
                });
            }
            // Auto-trigger login if no session on first launch.
            {
                use crate::state::AppState;
                use crate::types::AuthState;
                let needs_login = matches!(
                    *app.state::<AppState>().auth_state.lock().unwrap(),
                    AuthState::NeedsLogin
                );
                if needs_login {
                    let h = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        {
                            *h.state::<AppState>().auth_state.lock().unwrap() = AuthState::InProgress;
                        }
                        let _ = h.emit("auth-progress", serde_json::json!({"stage": "starting"}));
                        match crate::auth::run(h.clone()).await {
                            Ok(()) => {
                                *h.state::<AppState>().auth_state.lock().unwrap() = AuthState::LoggedIn;
                                let _ = crate::scheduler::poll_once(&h, crate::scheduler::PollTrigger::Scheduled).await;
                            }
                            Err(e) => {
                                *h.state::<AppState>().auth_state.lock().unwrap() = AuthState::NeedsLogin;
                                log::error!("auto-login failed: {e}");
                            }
                        }
                    });
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
                crate::channels::kill_all(app_handle);
            }
        });
}

/// Re-writes `~/.claude/settings.json` if the user already accepted hook
/// registration but on an older installer version. Heals the v1 entry
/// whose `matcher: "aiusage-taskbar"` field silently suppressed every
/// SessionStart/SessionEnd firing.
fn migrate_hook_install_if_needed(app: &tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    let state = app.state::<crate::state::AppState>();
    let (should_run, port) = {
        let s = state.settings.lock().unwrap();
        let stale = s.hooks_registered
            && s.hook_install_version < crate::hook_installer::CURRENT_INSTALL_VERSION;
        (stale, s.hook_port)
    };
    if !should_run { return; }
    let Some(port) = port else { return };
    if let Err(e) = crate::hook_installer::install(crate::hook_installer::HookConfig { port }) {
        log::warn!("hook install migration failed: {e}");
        return;
    }
    let snapshot = {
        let mut g = state.settings.lock().unwrap();
        g.hook_install_version = crate::hook_installer::CURRENT_INSTALL_VERSION;
        g.clone()
    };
    if let Ok(path) = paths::settings_file() {
        let _ = crate::settings::save(&path, &snapshot);
    }
    let _ = app.emit("settings-changed", snapshot);
    log::info!(
        "hook install migrated to v{}",
        crate::hook_installer::CURRENT_INSTALL_VERSION
    );
}

/// Re-registers every live Claude Code session from `~/.claude/sessions/*.json`.
/// The instance registry is in-memory only; without this, restarting the
/// taskbar app (or starting it after Claude was already running) left the
/// UI blank until each session happened to fire another SessionStart hook,
/// which Claude only does on session creation.
///
/// Dead session files are filtered by checking live pids via sysinfo.
/// `Registry::register` dedupes by session_id so overlap with a
/// concurrent SessionStart hook is safe.
fn rehydrate_instances_from_session_files(app: &tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    let state = app.state::<crate::state::AppState>();
    let mut sys = sysinfo::System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All);
    let live_processes: std::collections::HashMap<u32, u64> = sys
        .processes()
        .iter()
        .map(|(p, proc)| (p.as_u32(), proc.start_time()))
        .collect();

    let scanned = crate::session_files::scan_live_sessions(&live_processes);
    if scanned.is_empty() { return; }

    let mut added = 0usize;
    for s in scanned {
        let started_at = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(s.started_at_ms)
            .unwrap_or_else(chrono::Utc::now)
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let is_ours = state.channels.list().iter().any(|c| c.pid == Some(s.pid));
        let (kind, is_remote) = if is_ours {
            (crate::types::InstanceKind::Automated, true)
        } else {
            (crate::types::InstanceKind::External, false)
        };
        let transcript_path = crate::token_stats::latest_transcript_for_cwd(&s.cwd);
        let input = crate::instances::RegisterInput {
            session_id: s.session_id.clone(),
            cwd: s.cwd,
            pid: s.pid,
            kind,
            is_remote,
            transcript_path,
            started_at,
        };
        let (_pid_proj, created) = state.instances.register(input, &state.settings, &now);
        if created { added += 1; }
        if let Some(bridge) = s.bridge_session_id {
            state.instances.set_bridge_session_id(&s.session_id, bridge);
        }
    }

    if added > 0 {
        // Persist any projects that got auto-created by the registrations.
        let snapshot = state.settings.lock().unwrap().clone();
        if let Ok(path) = paths::settings_file() {
            let _ = crate::settings::save(&path, &snapshot);
        }
        let _ = app.emit("settings-changed", snapshot);
    }

    let _ = app.emit("instances-changed", state.instances.list());
    log::info!("rehydrated {added} instance(s) from ~/.claude/sessions");
}

async fn check_updater(app: &tauri::AppHandle) -> anyhow::Result<()> {
    use tauri_plugin_updater::UpdaterExt;
    use tauri::Emitter;
    let updater = app.updater()?;
    if let Some(update) = updater.check().await? {
        let _ = app.emit("update-state", serde_json::json!({
            "state": "available", "version": update.version
        }));
    }
    Ok(())
}
