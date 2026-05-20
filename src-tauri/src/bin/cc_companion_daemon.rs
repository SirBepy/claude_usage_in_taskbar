//! cc-companion-daemon: long-running helper process that owns chat-hub
//! claude subprocesses. Phase 3 added daemon-side hook server + sessions
//! registry + pending request map; the daemon now owns hook ingress at
//! port 27182 and the Phase 1 socket transport at the named pipe.

use claude_usage_tauri_lib::daemon::lockfile::LockGuard;
use claude_usage_tauri_lib::daemon::rpc::Router;
use claude_usage_tauri_lib::daemon::session::new_session_map;
use claude_usage_tauri_lib::daemon::settings_cache::SettingsCache;
use claude_usage_tauri_lib::daemon::state::DaemonState;
use claude_usage_tauri_lib::daemon::{channels, detector_task, health, hooks_server, methods, transport_windows};
use claude_usage_tauri_lib::settings;
use claude_usage_tauri_lib::types::Settings;
use std::path::PathBuf;

fn app_data_dir() -> PathBuf {
    let mut p = dirs::data_dir().expect("data_dir");
    p.push("claude-usage-tauri");
    p
}

fn load_initial_settings() -> Settings {
    // Best-effort load. If settings.json is missing / unparseable, the daemon
    // starts with Settings::default(); the app will push its authoritative
    // copy on connect via `set_settings`. Hook traffic that arrives in the
    // gap creates project_id entries that the app reconciles when it pushes
    // its snapshot back.
    let Ok(path) = settings::paths::settings_file() else { return Settings::default() };
    settings::load(&path)
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .init();

    let app_data = app_data_dir();
    std::fs::create_dir_all(&app_data)?;
    let lock_path = app_data.join("daemon.lock");
    let _lock = LockGuard::acquire(lock_path)?;

    let initial_settings = load_initial_settings();
    let settings_cache = SettingsCache::new(initial_settings);
    let state = DaemonState::new(new_session_map(), settings_cache.clone());

    let mut router = Router::new();
    health::register(&mut router);
    methods::register(&mut router, state.clone());
    methods::register_notifier(&mut router, state.notifier.clone());
    methods::register_settings(&mut router, settings_cache);
    methods::register_responders(&mut router, state.clone());
    methods::register_channels(&mut router, state.clone());

    // Bind hook server BEFORE the RPC accept loop so in-flight claude
    // processes can re-discover the port the moment we're up.
    let _hook_port = hooks_server::spawn(state.clone()).await?;
    detector_task::spawn(state.clone());

    // Adopt bridges that survived a previous daemon shutdown before spawning
    // new ones. This prevents duplicate bridge trees on daemon restart when
    // a channel is still running from the previous daemon lifetime.
    channels::adopt_running_channels(state.clone());

    // Autostart automated channels the daemon owns. Channels survive app
    // close; no auto-restart on exit (see daemon::channels). The in-session
    // dedup guard in start_channel will skip any project already adopted above.
    channels::autostart_all(state.clone());

    #[cfg(windows)]
    {
        let pipe_name = transport_windows::pipe_name_for_user();
        log::info!("daemon listening on {pipe_name}");
        let accept = tokio::spawn(async move {
            transport_windows::accept_loop(&pipe_name, router).await
        });
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                log::info!("daemon: ctrl-c received, shutting down");
            }
            r = accept => {
                if let Ok(Err(e)) = r {
                    log::error!("daemon: accept loop failed: {e}");
                }
            }
        }
    }
    #[cfg(not(windows))]
    {
        log::warn!("daemon: non-Windows transport not implemented");
        tokio::signal::ctrl_c().await?;
    }
    Ok(())
}
