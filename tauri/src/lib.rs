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
        .plugin(tauri_plugin_log::Builder::new().build())
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
            crate::scheduler::spawn(app.handle().clone());
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = crate::hook_server::spawn(handle).await {
                    log::error!("hook server spawn failed: {e}");
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
