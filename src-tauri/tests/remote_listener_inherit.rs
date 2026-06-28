//! Regression test for the remote-port (27183) variant of the daemon-port-
//! hostage incident. The hook listener (27182) was fixed in 2026-06, but the
//! remote-access listener bound its socket with a plain `TcpListener::bind` and
//! never stripped the inherit flag - so it leaked into daemon-spawned children
//! (piped stdio forces `bInheritHandles=TRUE` on Windows). A killed daemon left
//! an orphaned child holding 27183, the OS still completed the TCP handshake but
//! nothing served, and every phone request hung with no response.
//!
//! `mark_listener_non_inheritable` (shared by both the hook and remote
//! listeners) must produce a socket that does NOT leak into child processes
//! spawned with piped stdio.

#![cfg(windows)]

use claude_conductor_lib::util::process::mark_listener_non_inheritable;
use std::process::{Command, Stdio};

#[tokio::test]
async fn marked_remote_listener_frees_port_despite_live_children() {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind ephemeral");
    mark_listener_non_inheritable(&listener);
    let port = listener.local_addr().expect("local_addr").port();

    // Child with piped stdio -> CreateProcess(bInheritHandles=TRUE): every
    // inheritable handle is copied into the child, exactly how daemon-spawned
    // claude children got a copy of the listener in the incident.
    let mut child = Command::new("powershell")
        .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn child");

    // "Kill the daemon": drop our handle while the child still lives. With the
    // inherit flag stripped the child holds no copy, so the port must be
    // immediately rebindable.
    drop(listener);

    let rebind = tokio::net::TcpListener::bind(("127.0.0.1", port)).await;
    let _ = child.kill();
    let _ = child.wait();
    assert!(
        rebind.is_ok(),
        "port {port} still bound after the owner closed it - the remote listener leaked into the child: {rebind:?}"
    );
}
