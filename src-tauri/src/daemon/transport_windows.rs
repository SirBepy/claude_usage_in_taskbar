//! Windows named-pipe transport for the daemon. Per-platform module; Unix
//! sockets are added in a later phase.

#![cfg(windows)]

use crate::daemon::frame::{read_frame, write_frame, FrameError};
use crate::daemon::handshake::{verify_handshake, HandshakeError};
use crate::daemon::rpc::{ConnectionContext, Message, Router};
use serde_json::{json, Value};
use std::io;
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

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

async fn serve_connection(
    mut pipe: NamedPipeServer,
    router: Router,
) -> Result<(), FrameError> {
    // 1. Handshake (unchanged from Phase 1).
    let first = read_frame(&mut pipe).await?;
    match verify_handshake(&first) {
        Err(HandshakeError::MissingField) => {
            let err = json!({
                "jsonrpc": "2.0", "id": null,
                "error": {"code": -32600, "message": "handshake missing protocol_version"}
            });
            write_frame(&mut pipe, &err).await?;
            return Ok(());
        }
        Err(HandshakeError::VersionMismatch { client, daemon }) => {
            let err = json!({
                "jsonrpc": "2.0", "id": null,
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
        "daemon_version": crate::daemon::health::DAEMON_VERSION,
        "protocol_version": crate::daemon::health::PROTOCOL_VERSION,
    });
    write_frame(&mut pipe, &hs_ok).await?;

    // Per-connection outbound queue + context for attach_session subscriptions.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Value>(256);
    let ctx = ConnectionContext::new(tx);

    // 2. Request + notification loop. `biased` drains outbound first so
    // notification latency stays low even under inbound load.
    let exit_result: Result<(), FrameError> = loop {
        tokio::select! {
            biased;
            Some(notif) = rx.recv() => {
                if let Err(e) = write_frame(&mut pipe, &notif).await {
                    break Err(e);
                }
            }
            frame_result = read_frame(&mut pipe) => {
                let frame = match frame_result {
                    Ok(f) => f,
                    Err(FrameError::Io(e)) if e.kind() == io::ErrorKind::UnexpectedEof
                        || e.kind() == io::ErrorKind::BrokenPipe => break Ok(()),
                    Err(e) => break Err(e),
                };
                let msg: Message = match serde_json::from_value(frame) {
                    Ok(m) => m,
                    Err(e) => {
                        let err = json!({
                            "jsonrpc": "2.0", "id": null,
                            "error": {"code": -32700, "message": format!("parse error: {e}")}
                        });
                        if let Err(e) = write_frame(&mut pipe, &err).await {
                            break Err(e);
                        }
                        continue;
                    }
                };
                match msg {
                    Message::Request(req) => {
                        let resp = router.dispatch(req, ctx.clone()).await;
                        let v: Value = serde_json::to_value(resp).map_err(FrameError::from)?;
                        if let Err(e) = write_frame(&mut pipe, &v).await {
                            break Err(e);
                        }
                    }
                    Message::Notification(_) | Message::Response(_) => {
                        // Phase 2: still ignore inbound notifications + stray responses.
                    }
                }
            }
        }
    };

    // Cleanup: abort all per-session subscription tasks on disconnect.
    let mut subs = ctx.subscriptions.lock().await;
    for (_, handle) in subs.drain() {
        handle.abort();
    }
    drop(subs);

    exit_result
}
