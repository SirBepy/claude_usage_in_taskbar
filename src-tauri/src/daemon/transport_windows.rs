//! Windows named-pipe transport for the daemon. Per-platform module; Unix
//! sockets are added in a later phase.

#![cfg(windows)]

use crate::daemon::frame::{read_frame, write_frame, FrameError};
use crate::daemon::handshake::{verify_handshake, HandshakeError};
use crate::daemon::health::{DAEMON_VERSION, PROTOCOL_VERSION};
use crate::daemon::rpc::{Message, Router};
use serde_json::{json, Value};
use std::io;
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

pub fn pipe_name_for_user() -> String {
    // SID-based naming is added in a later phase. For Phase 1, a per-user
    // suffix via USERNAME is sufficient on a single dev machine.
    let user = std::env::var("USERNAME").unwrap_or_else(|_| "default".to_string());
    format!(r"\\.\pipe\cc-companion-daemon-{user}")
}

pub async fn accept_loop(pipe_name: &str, router: Router) -> io::Result<()> {
    // First server instance must be created with `first_pipe_instance(true)`.
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .create(pipe_name)?;

    loop {
        server.connect().await?;
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

async fn serve_connection(
    mut pipe: NamedPipeServer,
    router: Router,
) -> Result<(), FrameError> {
    // 1. Handshake.
    let first = read_frame(&mut pipe).await?;
    match verify_handshake(&first) {
        Err(HandshakeError::MissingField) => {
            let err = json!({
                "jsonrpc": "2.0",
                "id": null,
                "error": {"code": -32600, "message": "handshake missing protocol_version"}
            });
            write_frame(&mut pipe, &err).await?;
            return Ok(());
        }
        Err(HandshakeError::VersionMismatch { client, daemon }) => {
            let err = json!({
                "jsonrpc": "2.0",
                "id": null,
                "error": {
                    "code": -32600,
                    "message": format!("protocol version mismatch: client {client}, daemon {daemon}")
                }
            });
            write_frame(&mut pipe, &err).await?;
            return Ok(());
        }
        Ok(()) => {}
    }
    let hs_ok = json!({
        "handshake": "ok",
        "daemon_version": DAEMON_VERSION,
        "protocol_version": PROTOCOL_VERSION,
    });
    write_frame(&mut pipe, &hs_ok).await?;

    // 2. Request loop.
    loop {
        let frame = match read_frame(&mut pipe).await {
            Ok(f) => f,
            Err(FrameError::Io(e)) if e.kind() == io::ErrorKind::UnexpectedEof
                || e.kind() == io::ErrorKind::BrokenPipe => return Ok(()),
            Err(e) => return Err(e),
        };
        let msg: Message = match serde_json::from_value(frame) {
            Ok(m) => m,
            Err(e) => {
                let err = json!({
                    "jsonrpc": "2.0",
                    "id": null,
                    "error": {"code": -32700, "message": format!("parse error: {e}")}
                });
                write_frame(&mut pipe, &err).await?;
                continue;
            }
        };
        match msg {
            Message::Request(req) => {
                let resp = router.dispatch(req).await;
                let v: Value = serde_json::to_value(resp)?;
                write_frame(&mut pipe, &v).await?;
            }
            Message::Notification(_) | Message::Response(_) => {
                // Phase 1: silently ignore. Notifications from client and stray
                // Response shapes are not part of the v1 protocol.
            }
        }
    }
}
