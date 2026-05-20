//! End-to-end: POST a SessionStart hook to the daemon, observe the
//! `instances_changed` notification reach the persistent client.
//!
//! `#[ignore]`'d because it binds port 27182 - conflicts with any running
//! local daemon and is unsuitable for parallel CI. Run manually with:
//!   cargo test --manifest-path src-tauri/Cargo.toml --test daemon_hooks_e2e -- --ignored --nocapture

#![cfg(windows)]

use claude_usage_tauri_lib::daemon_client::PersistentClient;
use claude_usage_tauri_lib::types::Settings;
use serde_json::json;
use std::process::{Command, Stdio};
use std::time::Duration;

#[tokio::test(flavor = "current_thread")]
#[ignore]
async fn session_start_hook_round_trips_to_client_notification() {
    // Build + spawn daemon.
    let build = Command::new("cargo")
        .args(["build", "--bin", "cc-companion-daemon"])
        .current_dir(std::env::current_dir().unwrap())
        .status()
        .expect("cargo build");
    assert!(build.success());
    let mut exe = std::env::current_dir().unwrap();
    exe.push("target");
    exe.push("debug");
    exe.push("cc-companion-daemon.exe");
    let mut child = Command::new(&exe)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn daemon");

    // Give the daemon time to bind both the pipe AND the hook port.
    tokio::time::sleep(Duration::from_millis(700)).await;

    let user = std::env::var("USERNAME").unwrap_or_else(|_| "default".to_string());
    let pipe_name = format!(r"\\.\pipe\cc-companion-daemon-{user}");
    let client = PersistentClient::connect(&pipe_name).await.expect("client connect");
    client.push_settings(&Settings::default()).await.expect("push_settings");
    let mut rx = client.subscribe_global().await.expect("subscribe_global");

    // POST a synthetic SessionStart.
    let body = json!({
        "session_id": "test-sess-abc",
        "cwd": "C:\\tmp\\daemon-e2e",
        "pid": 99999,
        "transcript_path": null,
        "source": "startup"
    });
    let http = reqwest::Client::new();
    let resp = http.post("http://127.0.0.1:27182/hooks/session-start")
        .json(&body)
        .send().await.expect("POST");
    assert!(resp.status().is_success());

    // Wait for the notification on the subscription.
    let notif = tokio::time::timeout(Duration::from_secs(2), rx.recv())
        .await
        .expect("notification arrived in time")
        .expect("channel open");
    assert_eq!(notif["method"], json!("instances_changed"));
    let instances = notif["params"]["instances"].as_array().expect("instances array");
    assert!(instances.iter().any(|i| i["session_id"] == json!("test-sess-abc")));

    // Mark ended.
    let resp = http.post("http://127.0.0.1:27182/hooks/session-end")
        .json(&json!({"session_id": "test-sess-abc", "reason": "test-cleanup"}))
        .send().await.expect("POST end");
    assert!(resp.status().is_success());

    let notif = tokio::time::timeout(Duration::from_secs(2), rx.recv())
        .await
        .expect("end notification")
        .expect("channel open");
    assert_eq!(notif["method"], json!("instances_changed"));

    // Cleanup.
    drop(client);
    let _ = child.kill();
    let _ = child.wait();
}
