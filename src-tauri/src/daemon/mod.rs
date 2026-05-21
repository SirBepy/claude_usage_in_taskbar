//! Daemon-side modules. The binary at `src/bin/cc_companion_daemon.rs`
//! consumes these via the `claude_usage_tauri_lib` library crate.

pub mod broadcast;
pub mod channel_adopt;
pub mod channels;
pub mod detector_task;
pub mod frame;
pub mod handshake;
pub mod health;
pub mod hooks_server;
pub mod jsonl_tail;
pub mod lifecycle;
pub mod lockfile;
pub mod methods;
pub mod notifier;
pub mod rpc;
pub mod session;
pub mod settings_cache;
pub mod spawn_self;
pub mod state;

#[cfg(windows)]
pub mod transport_windows;

use crate::daemon::lockfile::LockGuard;
use crate::daemon::rpc::Router;
use crate::daemon::session::new_session_map;
use crate::daemon::settings_cache::SettingsCache;
use crate::daemon::state::DaemonState;
use crate::types::Settings;
use std::path::PathBuf;

fn app_data_dir() -> PathBuf {
    let mut p = dirs::data_dir().expect("data_dir");
    p.push("claude-usage-tauri");
    p
}

fn load_initial_settings() -> Settings {
    // Best-effort load. If settings.json is missing / unparseable, the daemon
    // starts with Settings::default(); the app pushes its authoritative copy on
    // connect via `set_settings`.
    let Ok(path) = crate::settings::paths::settings_file() else { return Settings::default() };
    crate::settings::load(&path)
}

/// Daemon process entry. Called by the standalone `cc-companion-daemon` bin
/// (used by the daemon e2e tests) and by the app binary when launched with
/// `--daemon`. Assumes a Tokio multi-thread runtime is already active.
pub async fn run_daemon_main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
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
    methods::register_chat_registry(&mut router, state.clone());

    // Bind hook server BEFORE the RPC accept loop so in-flight claude
    // processes can re-discover the port the moment we're up.
    let _hook_port = hooks_server::spawn(state.clone()).await?;
    detector_task::spawn(state.clone());

    // Adopt bridges that survived a previous daemon shutdown before spawning
    // new ones (prevents duplicate bridge trees on daemon restart).
    channel_adopt::adopt_running_channels(state.clone());

    // Autostart automated channels the daemon owns. The in-session dedup guard
    // in start_channel skips any project already adopted above.
    channels::autostart_all(state.clone());

    #[cfg(windows)]
    {
        let pipe_name = transport_windows::pipe_name_for_user();
        log::info!("daemon listening on {pipe_name}");
        let shutdown = state.shutdown.clone();
        let accept = tokio::spawn(async move {
            transport_windows::accept_loop(&pipe_name, router).await
        });
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                log::info!("daemon: ctrl-c received, shutting down");
            }
            _ = shutdown.notified() => {
                log::info!("daemon: shutdown_daemon RPC received, exiting");
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
