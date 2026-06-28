//! Unix-domain-socket transport for the daemon (macOS + Linux). Mirrors the
//! Windows named-pipe transport; the handshake + request loop is shared via
//! `transport_common`. The socket lives under the app data dir so the client
//! and daemon derive the identical path.

#![cfg(unix)]

use crate::daemon::rpc::Router;
use crate::daemon::transport_common::serve_connection;
use std::io;
use std::path::PathBuf;
use tokio::net::UnixListener;

/// Socket path for the current user, matching the named-pipe naming on Windows.
/// The instance suffix (empty in production) isolates test daemons (ai_todo 71).
pub fn socket_path_for_user() -> PathBuf {
    let mut p = dirs::data_dir().unwrap_or_else(std::env::temp_dir);
    p.push("claude-conductor");
    let inst = crate::daemon::instance::instance_suffix();
    p.push(format!("cc-conductor-daemon{inst}.sock"));
    p
}

pub async fn accept_loop(socket_path: &std::path::Path, router: Router) -> io::Result<()> {
    // The data dir is created by run_daemon_main, but be defensive.
    if let Some(parent) = socket_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // A leftover socket file from a previous run makes bind() fail with
    // EADDRINUSE even though nothing is listening. The lockfile already
    // guarantees we're the only daemon, so removing it here is safe.
    let _ = std::fs::remove_file(socket_path);

    let listener = UnixListener::bind(socket_path)?;
    loop {
        match listener.accept().await {
            Ok((stream, _addr)) => {
                let router_clone = router.clone();
                tokio::spawn(async move {
                    if let Err(e) = serve_connection(stream, router_clone).await {
                        log::warn!("daemon: connection ended with error: {e}");
                    }
                });
            }
            Err(e) => {
                // Transient accept errors should log and continue, not kill the
                // daemon (mirrors the Windows connect-error handling).
                log::warn!("daemon: unix accept failed, retrying: {e}");
            }
        }
    }
}
