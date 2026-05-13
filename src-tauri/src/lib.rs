pub mod channels;
pub mod characters;
pub mod files;
pub mod chat;
pub mod auth;
pub mod hooks;
pub mod mcp;
pub mod news;
pub mod notifications;
pub mod history;
pub mod ipc;
pub mod scheduler;
pub mod scraping;
pub mod sessions;
pub mod settings;
pub mod skill_usage;
pub mod slash;
pub mod state;
pub mod tokens;
pub mod tray;
pub mod types;
pub mod util;

use crate::settings::paths;
use crate::state::AppState;
use crate::types::AuthState;
use crate::auth::session;
use tauri::Emitter;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = paths::ensure_data_dir();
    match crate::characters::bundled::ensure_bundled() {
        Ok(n) if n > 0 => log::info!("characters: copied {n} bundled character(s) into app-data"),
        Ok(_) => {}
        Err(e) => log::warn!("characters: bundled copy failed: {e:#}"),
    }
    let settings_path = paths::settings_file().expect("settings path");
    let session_path = paths::session_file().expect("session path");
    let loaded_settings = settings::load(&settings_path);
    let auth = if session::load(&session_path).is_some() {
        AuthState::LoggedIn
    } else {
        AuthState::NeedsLogin
    };

    let state = AppState::new(loaded_settings, auth);

    #[cfg_attr(debug_assertions, allow(unused_mut))]
    let mut builder = tauri::Builder::default();

    // Release-only: prevent a second instance from launching. In dev,
    // the predev script already kills any running instance, and we want
    // `cargo tauri dev` to proceed even if a prod build is installed.
    #[cfg(not(debug_assertions))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    }

    builder
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(state)
        .manage(std::sync::Arc::new(crate::ipc::chat::ChatState::new()))
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
            ipc::list_audio_output_devices,
            ipc::copy_logs,
            ipc::get_platform,
            ipc::get_app_version,
            ipc::pick_folder,
            ipc::open_external,
            ipc::check_for_updates,
            ipc::download_and_install_update,
            ipc::install_update,
            ipc::get_update_state,
            ipc::list_projects,
            ipc::get_project,
            ipc::ensure_project,
            ipc::update_project,
            ipc::delete_project,
            ipc::set_projects_sort_by,
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
            ipc::list_project_groups,
            ipc::project_last_activity_at,
            ipc::list_characters,
            ipc::assign_character,
            ipc::play_character_slot,
            ipc::character_asset_url,
            ipc::preview_character_file,
            ipc::stop_character_preview,
            ipc::get_characters_dir,
            ipc::invalidate_characters_cache,
            ipc::start_session,
            ipc::send_message,
            ipc::set_session_effort,
            ipc::cancel_turn,
            ipc::clear_session,
            ipc::paste_image,
            ipc::read_attachment,
            ipc::takeover_manual,
            ipc::load_history,
            ipc::load_history_page,
            ipc::list_history,
            ipc::register_historical_session,
            ipc::detach_window,
            ipc::reattach_window,
            ipc::get_git_info,
            ipc::get_git_dirty,
            ipc::respond_permission,
            ipc::respond_question,
            ipc::list_news,
            ipc::refresh_news,
            ipc::mark_news_read,
            ipc::mark_all_news_read,
            ipc::list_slash_commands,
            ipc::list_project_files,
            ipc::get_skill_usage_week,
            ipc::get_skill_usage_detail,
            ipc::list_installed_skills,
            ipc::frontend_ready,
        ])
        .setup(|app| {
            log::info!("claude-usage-tauri started");
            #[cfg(target_os = "macos")]
            {
                let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
            crate::tray::setup(app.handle())?;
            // Schedule chat-attachments GC: run once on startup, then every 24h.
            // Removes pasted-image directories whose mtime is older than 30 days.
            tauri::async_runtime::spawn(async move {
                loop {
                    crate::ipc::chat::gc_attachments().await;
                    tokio::time::sleep(std::time::Duration::from_secs(24 * 3600)).await;
                }
            });
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
                let h = app.handle().clone();
                tauri::async_runtime::spawn(auto_update_loop(h));
            }
            crate::scheduler::spawn(app.handle().clone());
            crate::news::spawn_poll_loop(app.handle().clone());
            crate::slash::watcher::spawn(app.handle().clone());

            // Auto-backfill token history once, off the main thread. Keeps
            // the stats page populated on first launch / after new sessions.
            {
                let h = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let Ok(path) = paths::token_history_file() else { return };
                    let path_clone = path.clone();
                    match tauri::async_runtime::spawn_blocking(move || {
                        crate::tokens::backfill_all(&path_clone)
                    })
                    .await
                    {
                        Ok(Ok(r)) => {
                            log::info!(
                                "startup backfill: {} new, {} skipped (sub: {} new, {} skipped)",
                                r.processed, r.skipped, r.sub_processed, r.sub_skipped
                            );
                            let history = crate::tokens::load_history(&path);
                            let _ = h.emit("token-history-updated", history);
                        }
                        Ok(Err(e)) => log::warn!("startup backfill failed: {e:?}"),
                        Err(e) => log::warn!("startup backfill join error: {e}"),
                    }
                });
            }
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = crate::hooks::spawn(handle.clone()).await {
                    log::error!("hook server spawn failed: {e}");
                    return;
                }
                migrate_hook_install_if_needed(&handle);
            });
            {
                let h = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    rehydrate_instances_from_session_files(&h);
                    crate::sessions::detector::run(h).await
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
                        use std::sync::atomic::Ordering;
                        let quitting = w.app_handle()
                            .try_state::<crate::state::AppState>()
                            .map(|s| s.should_quit.load(Ordering::SeqCst))
                            .unwrap_or(false);
                        if quitting {
                            return;
                        }
                        api.prevent_close();
                        let _ = w.eval("window.navigateTo && window.navigateTo('dashboard')");
                        let _ = w.hide();
                    }
                });
            }
            // Webview boot watchdog. If `frontend_ready` IPC never fires
            // within ~6s, force-navigate the main window back to the start
            // URL. Covers: WebView2 showing "localhost refused to connect"
            // when the start URL was unreachable at boot (autostart racing
            // a slow vite dev server, or just no network when something
            // upstream needed it). Retries every 5s for up to 2 minutes.
            {
                let h = app.handle().clone();
                let alive = app.state::<AppState>().frontend_alive.clone();
                tauri::async_runtime::spawn(async move {
                    use std::sync::atomic::Ordering;
                    tokio::time::sleep(std::time::Duration::from_secs(6)).await;
                    let mut attempts = 0u32;
                    while !alive.load(Ordering::SeqCst) && attempts < 24 {
                        attempts += 1;
                        let url = boot_start_url();
                        if let Some(w) = h.get_webview_window("main") {
                            log::warn!(
                                "frontend not ready after {}s; reloading main webview -> {}",
                                6 + (attempts - 1) * 5,
                                url
                            );
                            if let Ok(parsed) = url.parse::<tauri::Url>() {
                                let _ = w.navigate(parsed);
                            }
                        }
                        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    }
                    if alive.load(Ordering::SeqCst) {
                        if attempts > 0 {
                            log::info!("frontend recovered after {attempts} reload attempt(s)");
                        }
                    } else {
                        log::error!(
                            "frontend never reported ready after {attempts} reload attempts; giving up"
                        );
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

/// URL the main webview was originally loaded from. Mirrors what Tauri's
/// internal host serves for `WebviewUrl::App("index.html")` (the value in
/// `tauri.conf.json`). Used by the boot watchdog to reload the window if
/// WebView2 ends up on an error page.
fn boot_start_url() -> String {
    if cfg!(dev) {
        "http://localhost:1420/index.html".to_string()
    } else if cfg!(target_os = "macos") || cfg!(target_os = "ios") {
        "tauri://localhost/index.html".to_string()
    } else {
        "http://tauri.localhost/index.html".to_string()
    }
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
            && s.hook_install_version < crate::hooks::CURRENT_INSTALL_VERSION;
        (stale, s.hook_port)
    };
    if !should_run { return; }
    let Some(port) = port else { return };
    if let Err(e) = crate::hooks::install(crate::hooks::HookConfig { port }) {
        log::warn!("hook install migration failed: {e}");
        return;
    }
    let snapshot = {
        let mut g = state.settings.lock().unwrap();
        g.hook_install_version = crate::hooks::CURRENT_INSTALL_VERSION;
        g.clone()
    };
    if let Ok(path) = paths::settings_file() {
        let _ = crate::settings::save(&path, &snapshot);
    }
    let _ = app.emit("settings-changed", snapshot);
    log::info!(
        "hook install migrated to v{}",
        crate::hooks::CURRENT_INSTALL_VERSION
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

    let scanned = crate::hooks::scan_live_sessions(&live_processes);
    if scanned.is_empty() { return; }

    let mut added = 0usize;
    for s in scanned {
        let started_at = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(s.started_at_ms)
            .unwrap_or_else(chrono::Utc::now)
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let is_ours = state.channels.list().iter().any(|c| c.pid == Some(s.pid));
        let (kind, is_remote) = if is_ours {
            (crate::sessions::kinds::InstanceKind::Automated, true)
        } else {
            (crate::sessions::kinds::InstanceKind::External, false)
        };
        // Per-session jsonl first; the cwd-wide "latest" file would
        // be identical for every concurrent session in the project.
        let transcript_path = crate::tokens::transcript_for_session(&s.cwd, &s.session_id)
            .or_else(|| crate::tokens::latest_transcript_for_cwd(&s.cwd));
        let name = transcript_path
            .as_deref()
            .and_then(|p| crate::tokens::first_user_prompt(p, 60));
        let input = crate::sessions::registry::RegisterInput {
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
        if let Some(n) = name {
            state.instances.set_name(&s.session_id, n);
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

/// Background loop that polls for new releases every 6h, doing nothing or
/// auto-installing depending on the current `autoUpdate` setting. Lives for the
/// app lifetime so toggling the setting from the UI takes effect on the next
/// tick (no restart required).
#[cfg(not(dev))]
async fn auto_update_loop(app: tauri::AppHandle) {
    use crate::types::AutoUpdateMode;
    use tauri::Manager;
    // Brief warmup so we don't hammer the network before the first usage poll.
    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
    let mut did_startup_check = false;
    loop {
        let mode = app.state::<crate::state::AppState>().settings.lock().unwrap().auto_update;
        match mode {
            AutoUpdateMode::Never => {}
            AutoUpdateMode::OnStartup => {
                if !did_startup_check {
                    let _ = crate::ipc::misc::run_update_check(&app, false).await;
                }
            }
            AutoUpdateMode::Immediate => {
                let _ = crate::ipc::misc::run_update_check(&app, true).await;
            }
        }
        did_startup_check = true;
        tokio::time::sleep(std::time::Duration::from_secs(6 * 3600)).await;
    }
}

#[cfg(dev)]
async fn auto_update_loop(_app: tauri::AppHandle) {
    // Updater is disabled in dev builds; loop body is a no-op.
}
