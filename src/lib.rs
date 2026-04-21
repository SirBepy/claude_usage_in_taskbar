pub mod audio;
pub mod auth;
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
pub mod icon;
pub mod ipc;
pub mod paths;
pub mod scheduler;
pub mod scraper;
pub mod session;
pub mod settings;
pub mod state;
pub mod token_stats;
pub mod tray;
pub mod types;

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
                if let Err(e) = crate::hook_server::spawn(handle).await {
                    log::error!("hook server spawn failed: {e}");
                }
            });
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
