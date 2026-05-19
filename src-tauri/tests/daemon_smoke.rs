//! End-to-end smoke for the daemon binary. Spawns the daemon, connects over
//! the Windows named pipe, runs the handshake + a single `health` RPC, then
//! kills the daemon.
//!
//! Only runs on Windows in Phase 1; the Unix transport isn't shipped yet.

#![cfg(windows)]

use claude_usage_tauri_lib::daemon::frame::{read_frame, write_frame};
use claude_usage_tauri_lib::daemon::health::PROTOCOL_VERSION;
use serde_json::json;
use std::process::{Command, Stdio};
use std::time::Duration;
use tokio::net::windows::named_pipe::ClientOptions;

fn daemon_exe() -> std::path::PathBuf {
    let mut p = std::env::current_dir().unwrap();
    p.push("target");
    p.push("debug");
    p.push("cc-companion-daemon.exe");
    p
}

#[tokio::test(flavor = "current_thread")]
async fn handshake_and_health() {
    // Build the daemon first; cargo doesn't auto-build sibling [[bin]]s for
    // integration tests of the lib crate.
    let build = Command::new("cargo")
        .args(["build", "--bin", "cc-companion-daemon"])
        .current_dir(std::env::current_dir().unwrap())
        .status()
        .expect("cargo build");
    assert!(build.success(), "cargo build failed");

    let exe = daemon_exe();
    assert!(exe.exists(), "daemon exe missing: {}", exe.display());

    // Clear any stale lockfile from a previous failed run; a zombie PID in
    // the lockfile would block the new daemon from acquiring the lock.
    if let Some(app_data) = dirs::data_dir() {
        let lock = app_data.join("claude-usage-tauri").join("daemon.lock");
        let _ = std::fs::remove_file(&lock);
    }

    // Spawn daemon. stdio piped so we can kill cleanly.
    let mut child = Command::new(&exe)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn daemon");

    let user = std::env::var("USERNAME").unwrap_or_else(|_| "default".to_string());
    let pipe_name = format!(r"\\.\pipe\cc-companion-daemon-{user}");

    // Retry-connect with a short backoff until the daemon has bound the pipe.
    let mut pipe = None;
    for _ in 0..50 {
        match ClientOptions::new().open(&pipe_name) {
            Ok(p) => { pipe = Some(p); break; }
            Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
        }
    }
    let mut pipe = pipe.expect("connect to daemon pipe within 2.5s");

    // Handshake.
    write_frame(&mut pipe, &json!({"protocol_version": PROTOCOL_VERSION})).await.unwrap();
    let resp = read_frame(&mut pipe).await.unwrap();
    assert_eq!(resp["handshake"], json!("ok"));
    assert_eq!(resp["protocol_version"], json!(PROTOCOL_VERSION));

    // Health RPC.
    write_frame(&mut pipe, &json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "health",
        "params": null
    })).await.unwrap();
    let resp = read_frame(&mut pipe).await.unwrap();
    assert_eq!(resp["jsonrpc"], json!("2.0"));
    assert_eq!(resp["id"], json!(1));
    assert!(resp["result"]["daemon_version"].is_string());
    assert_eq!(resp["result"]["protocol_version"], json!(PROTOCOL_VERSION));

    // Clean shutdown.
    drop(pipe);
    let _ = child.kill();
    let _ = child.wait();
}
