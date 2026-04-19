pub mod auth;
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
            crate::scheduler::spawn(app.handle().clone());
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
                                let _ = crate::scheduler::poll_once(&h).await;
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
