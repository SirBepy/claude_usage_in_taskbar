//! Regression test for the 2026-06-12 daemon-port-hostage incident: the hook
//! listener leaked into daemon-spawned children via handle inheritance, so a
//! killed daemon left port 27182 bound by its orphaned children and every new
//! daemon died on bind (os error 10048) until the orphans were killed.
//!
//! `bind_hook_listener` must produce a listener that does NOT leak into child
//! processes spawned with piped stdio (which forces `bInheritHandles=TRUE` on
//! Windows - the daemon spawns every claude chat child that way).

#![cfg(windows)]

use claude_conductor_lib::daemon::hooks_server::bind_hook_listener;
use std::process::{Command, Stdio};

#[tokio::test]
async fn killed_owner_frees_port_despite_live_children() {
    let listener = bind_hook_listener(0).await.expect("bind ephemeral");
    let port = listener.local_addr().expect("local_addr").port();

    // Child with piped stdio -> CreateProcess(bInheritHandles=TRUE): every
    // inheritable handle in this process is copied into the child. This is
    // exactly how daemon-spawned claude children got a copy of the hook
    // listener in the incident.
    let mut child = Command::new("powershell")
        .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn child");

    // "Kill the daemon": close our handle while the child still lives. With
    // the inherit flag stripped the child holds no copy, so the port must be
    // immediately rebindable.
    drop(listener);

    let rebind = tokio::net::TcpListener::bind(("127.0.0.1", port)).await;
    let _ = child.kill();
    let _ = child.wait();
    assert!(
        rebind.is_ok(),
        "port {port} still bound after the owner closed it - the listener leaked into the child: {rebind:?}"
    );
}
