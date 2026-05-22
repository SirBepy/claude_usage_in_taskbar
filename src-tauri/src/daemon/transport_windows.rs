//! Windows named-pipe transport for the daemon. Per-platform accept loop; the
//! handshake + request/notification loop is shared via `transport_common`.

#![cfg(windows)]

use crate::daemon::rpc::Router;
use crate::daemon::transport_common::serve_connection;
use std::io;
use tokio::net::windows::named_pipe::ServerOptions;

pub fn pipe_name_for_user() -> String {
    // SID-based naming is added in a later phase. For Phase 1, a per-user
    // suffix via USERNAME is sufficient on a single dev machine. The instance
    // suffix (empty in production) isolates test daemons (ai_todo 71).
    let user = std::env::var("USERNAME").unwrap_or_else(|_| "default".to_string());
    let inst = crate::daemon::instance::instance_suffix();
    format!(r"\\.\pipe\cc-companion-daemon-{user}{inst}")
}

pub async fn accept_loop(pipe_name: &str, router: Router) -> io::Result<()> {
    // First server instance must be created with `first_pipe_instance(true)`.
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .create(pipe_name)?;

    loop {
        // Transient connect errors (e.g. ERROR_NO_DATA on close-race) should
        // log and continue, not kill the daemon. We only abort on errors
        // creating the NEXT server, which would mean the pipe is unusable.
        if let Err(e) = server.connect().await {
            log::warn!("daemon: pipe connect failed, retrying: {e}");
            server = ServerOptions::new().create(pipe_name)?;
            continue;
        }
        let connected = server;
        // Pre-create the next server BEFORE handling the current client so the
        // pipe stays open for the next connection (standard tokio pattern).
        server = ServerOptions::new().create(pipe_name)?;

        let router_clone = router.clone();
        tokio::spawn(async move {
            if let Err(e) = serve_connection(connected, router_clone).await {
                log::warn!("daemon: connection ended with error: {e}");
            }
        });
    }
}
