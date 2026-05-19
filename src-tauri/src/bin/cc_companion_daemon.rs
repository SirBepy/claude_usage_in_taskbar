//! cc-companion-daemon: long-running helper process that owns chat-hub
//! claude subprocesses. Phase 1 ships scaffolding + handshake only.

use claude_usage_tauri_lib::daemon::lockfile::LockGuard;
use claude_usage_tauri_lib::daemon::rpc::Router;
use claude_usage_tauri_lib::daemon::{health, methods, session, transport_windows};
use std::path::PathBuf;

fn app_data_dir() -> PathBuf {
    let mut p = dirs::data_dir().expect("data_dir");
    p.push("claude-usage-tauri");
    p
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .init();

    let app_data = app_data_dir();
    std::fs::create_dir_all(&app_data)?;
    let lock_path = app_data.join("daemon.lock");
    let _lock = LockGuard::acquire(lock_path)?;

    let mut router = Router::new();
    health::register(&mut router);
    let session_map = session::new_session_map();
    methods::register(&mut router, session_map);

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
        log::warn!("daemon: non-Windows transport not implemented in Phase 1");
        tokio::signal::ctrl_c().await?;
    }
    Ok(())
}
