//! End-to-end integration tests for the daemon chat path (ai_todo 67).
//!
//! Manual run only:
//!   cargo test --manifest-path src-tauri/Cargo.toml --test daemon_chat_e2e -- --ignored --nocapture
//!
//! These tests SPAWN A REAL DAEMON and bind the fixed hook port (27182), so
//! they are `#[ignore]` to stay out of the default `cargo test` run (which
//! would otherwise kill a running daemon / collide on the port).
//!
//! `interactive_survives_session_end_hook` is FREE (no `claude` process): it
//! exercises only the registry + hook server. `end_to_end_no_duplicate_events`
//! spawns a real `claude` turn and burns a tiny slice of subscription quota.

#![cfg(windows)]

use claude_usage_tauri_lib::daemon_client::{pipe_name_for_current_user, PersistentClient};
use serde_json::{json, Value};
use std::process::{Command, Stdio};
use std::time::Duration;

const HOOK_PORT: u16 = 27182;

fn daemon_exe() -> std::path::PathBuf {
    let mut p = std::env::current_dir().unwrap();
    p.push("target");
    p.push("debug");
    p.push("cc-companion-daemon.exe");
    p
}

/// Kill any prior daemon and clear the lockfile, then build + spawn a fresh one
/// and connect a client. Returns the child handle and the connected client.
async fn spawn_daemon_and_connect() -> (std::process::Child, PersistentClient) {
    let _ = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "Get-Process cc-companion-daemon -ErrorAction SilentlyContinue | Stop-Process -Force",
        ])
        .status();
    if let Some(app_data) = dirs::data_dir() {
        let lock = app_data.join("claude-usage-tauri").join("daemon.lock");
        let _ = std::fs::remove_file(&lock);
    }

    let build = Command::new("cargo")
        .args(["build", "--bin", "cc-companion-daemon"])
        .status()
        .expect("cargo build");
    assert!(build.success());

    let child = Command::new(daemon_exe())
        // Surface the daemon's debug log (publishes + lag drops) on the test's
        // own stderr so `--nocapture` runs show exactly what was published vs
        // delivered.
        .env("RUST_LOG", "info,claude_usage_tauri_lib=debug")
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn daemon");

    tokio::time::sleep(Duration::from_millis(800)).await;

    let client = PersistentClient::connect(&pipe_name_for_current_user())
        .await
        .expect("connect");
    (child, client)
}

fn find_instance<'a>(instances: &'a Value, session_id: &str) -> Option<&'a Value> {
    instances
        .as_array()?
        .iter()
        .find(|i| i.get("session_id").and_then(Value::as_str) == Some(session_id))
}

/// Regression test for the per-turn SessionEnd auto-close bug (observed
/// 2026-05-21): in Path C every user turn spawns a short-lived `claude -p`
/// process that fires the SessionEnd hook when the turn completes. That hook
/// must NOT close the daemon-owned Interactive session - its lifecycle is the
/// chat IPC layer's, exactly like the detector already exempts Interactive
/// sessions from pid-based ending (sessions/detector.rs).
#[tokio::test(flavor = "current_thread")]
#[ignore]
async fn interactive_survives_session_end_hook() {
    let (mut child, client) = spawn_daemon_and_connect().await;

    let session_id = format!("test-autoclose-{}", std::process::id());
    let cwd = std::env::temp_dir().to_string_lossy().to_string();

    // Register an Interactive session in the registry without spawning claude.
    client
        .call(
            "register_historical",
            json!({ "session_id": session_id, "cwd": cwd }),
        )
        .await
        .expect("register_historical");

    // Sanity: it exists and is a live Interactive entry.
    let before = client.call("list_instances", json!({})).await.expect("list");
    let inst = find_instance(&before, &session_id).expect("session registered");
    assert_eq!(inst.get("kind").and_then(Value::as_str), Some("interactive"));
    assert!(inst.get("ended_at").map(Value::is_null).unwrap_or(true), "should start alive");

    // Fire the per-turn SessionEnd hook the way a completing `claude -p` would.
    let http = reqwest::Client::new();
    let resp = http
        .post(format!("http://127.0.0.1:{HOOK_PORT}/hooks/session-end"))
        .json(&json!({ "session_id": session_id, "reason": "other" }))
        .send()
        .await
        .expect("POST /hooks/session-end");
    assert!(resp.status().is_success(), "hook POST status: {}", resp.status());

    // Give the daemon a beat to process.
    tokio::time::sleep(Duration::from_millis(300)).await;

    let after = client.call("list_instances", json!({})).await.expect("list");
    let inst = find_instance(&after, &session_id)
        .expect("Interactive session must NOT be removed by a per-turn SessionEnd hook");
    let ended_at = inst.get("ended_at").cloned().unwrap_or(Value::Null);

    // Cleanup before asserting so a failure doesn't leak the daemon.
    drop(client);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let _ = child.kill();
    let _ = child.wait();

    assert!(
        ended_at.is_null(),
        "Interactive session was auto-closed by a per-turn SessionEnd hook (ended_at={ended_at}). \
         The daemon owns Interactive lifecycle; hook SessionEnd must be ignored for kind=interactive."
    );
}

/// Phase 5b flow 5 (takeover) over the daemon RPC path. Free + deterministic:
/// register an External session via the session-start hook with a safe fake pid
/// (999999, so the real kill_tree is a no-op and no live process is touched),
/// then drive `takeover_manual` and assert the entry promotes to Interactive.
/// The takeover *logic* is unit-tested in chat/takeover.rs; this covers the
/// daemon RPC wiring (hook -> registry -> takeover_manual -> notification).
#[tokio::test(flavor = "current_thread")]
#[ignore]
async fn takeover_manual_promotes_external_to_interactive() {
    let (mut child, client) = spawn_daemon_and_connect().await;

    let session_id = format!("test-takeover-{}", std::process::id());
    let cwd = std::env::temp_dir().to_string_lossy().to_string();
    let fake_pid = 999_999u32; // not a live process -> kill_tree is a safe no-op

    // Register as External via the session-start hook (non-channel pid).
    let http = reqwest::Client::new();
    let resp = http
        .post(format!("http://127.0.0.1:{HOOK_PORT}/hooks/session-start"))
        .json(&json!({ "session_id": session_id, "cwd": cwd, "pid": fake_pid }))
        .send()
        .await
        .expect("POST /hooks/session-start");
    assert!(resp.status().is_success());
    tokio::time::sleep(Duration::from_millis(300)).await;

    let before = client.call("list_instances", json!({})).await.expect("list");
    let inst = find_instance(&before, &session_id).expect("external session registered");
    assert_eq!(inst.get("kind").and_then(Value::as_str), Some("external"));

    // Takeover over RPC.
    client
        .call(
            "takeover_manual",
            json!({ "manual_pid": fake_pid, "model": "haiku", "effort": "low" }),
        )
        .await
        .expect("takeover_manual");

    let after = client.call("list_instances", json!({})).await.expect("list");
    let inst = find_instance(&after, &session_id).cloned();

    drop(client);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let _ = child.kill();
    let _ = child.wait();

    let inst = inst.expect("session still present after takeover");
    assert_eq!(
        inst.get("kind").and_then(Value::as_str),
        Some("interactive"),
        "takeover_manual must promote the External session to Interactive"
    );
}

/// Duplication guard (ai_todo 67): a single turn must produce no duplicate
/// stream events. Spawns a real `claude` turn (subscription-billed, tiny).
#[tokio::test(flavor = "current_thread")]
#[ignore]
async fn end_to_end_no_duplicate_events() {
    let (mut child, client) = spawn_daemon_and_connect().await;

    let cwd = std::env::temp_dir().to_string_lossy().to_string();
    let start = client
        .call(
            "start_session",
            json!({ "cwd": cwd, "model": "haiku", "effort": "low", "resume_id": null }),
        )
        .await
        .expect("start_session");
    let session_id = start["session_id"].as_str().expect("session_id").to_string();

    let mut rx = client.attach_session(&session_id).await.expect("attach");
    client
        .call(
            "send_message",
            json!({ "session_id": session_id, "text": "reply with the literal word OK and stop." }),
        )
        .await
        .expect("send_message");

    // Collect the FULL event stream for the turn. Do not break on the first
    // turn_usage - keep draining a short tail so we can see every delivered
    // variant (and catch duplicates / missing assistant text).
    let mut assistant_msgs = 0;
    let mut finalized_assistant = 0;
    let mut turn_usages = 0;
    let mut delivered: Vec<String> = Vec::new();
    let deadline = std::time::Instant::now() + Duration::from_secs(90);
    let mut saw_turn_usage = false;
    while std::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
            Ok(Some(notif)) => {
                let variant = notif
                    .pointer("/params/event")
                    .and_then(Value::as_object)
                    .and_then(|o| o.get("type"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                eprintln!("delivered chat_event: {variant:?}");
                if let Some(v) = variant.clone() {
                    delivered.push(v);
                }
                match variant.as_deref() {
                    Some("assistant_message") => {
                        assistant_msgs += 1;
                        let streaming = notif
                            .pointer("/params/event/streaming")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        if !streaming {
                            finalized_assistant += 1;
                        }
                    }
                    Some("turn_usage") => {
                        turn_usages += 1;
                        saw_turn_usage = true;
                    }
                    _ => {}
                }
            }
            Ok(None) => break,
            // After the turn completed, give a brief grace window for any
            // trailing events, then stop.
            Err(_) => {
                if saw_turn_usage {
                    break;
                }
            }
        }
    }
    eprintln!("delivered variants in order: {delivered:?}");

    let _ = client.call("end_session", json!({ "session_id": session_id })).await;
    drop(client);
    tokio::time::sleep(Duration::from_millis(500)).await;
    let _ = child.kill();
    let _ = child.wait();

    eprintln!(
        "assistant_msgs={assistant_msgs} finalized_assistant={finalized_assistant} turn_usages={turn_usages}"
    );
    assert_eq!(
        turn_usages, 1,
        "exactly one turn_usage expected per turn (got {turn_usages})"
    );
    assert_eq!(
        finalized_assistant, 1,
        "exactly one finalized (non-streaming) assistant_message expected per turn (got {finalized_assistant})"
    );
    assert!(
        assistant_msgs >= 1,
        "expected at least one assistant_message (got {assistant_msgs})"
    );
}
