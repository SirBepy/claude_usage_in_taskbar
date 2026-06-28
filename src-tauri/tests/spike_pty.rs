//! Phase 0 spike: confirm whether claude CLI supports stream-json in interactive PTY mode.
//! Gated behind --ignored; manual run only:
//!   cargo test -p claude-conductor --test spike_pty -- --ignored --nocapture
//!
//! Phase 0 result (2026-05-07): stream-json only works with --print.
//! See docs/superpowers/specs/2026-05-07-claude-chat-hub-design.md "Phase 0 result".
//!
//! Extension: characterize the interactive TUI byte stream + verify print/resume modes,
//! producing a fixture corpus for the future ANSI parser plan.

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn fixture_dir() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let dir = manifest.join("..").join(".for_bepy").join("spike_fixtures");
    fs::create_dir_all(&dir).expect("create fixture dir");
    dir
}

/// Drain a PTY reader for up to `duration`. Backed by a worker thread because
/// portable-pty's `read()` blocks indefinitely on Windows when no data is
/// available, so we can't time-bound by checking elapsed in the main thread.
/// After `duration` elapses, the caller is expected to kill the child + drop
/// the master, which causes the read to error out and the worker to exit.
fn drain_pty_for(
    mut reader: Box<dyn Read + Send>,
    duration: Duration,
    max_bytes: usize,
) -> Vec<u8> {
    let buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let buf_clone = Arc::clone(&buf);
    let handle = std::thread::spawn(move || {
        let mut local = [0u8; 4096];
        loop {
            match reader.read(&mut local) {
                Ok(0) => break,
                Ok(n) => {
                    let mut g = buf_clone.lock().unwrap();
                    g.extend_from_slice(&local[..n]);
                    if g.len() >= max_bytes {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let start = Instant::now();
    while start.elapsed() < duration {
        if handle.is_finished() {
            break;
        }
        if buf.lock().unwrap().len() >= max_bytes {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    // Detach the thread - it will unblock when the caller drops the master/kills child.
    // We don't join because the read() may still be blocking even if duration elapsed.
    drop(handle);

    let g = buf.lock().unwrap();
    g.clone()
}

#[test]
#[ignore]
fn stream_json_interactive_works() {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows: 50, cols: 200, pixel_width: 0, pixel_height: 0 })
        .expect("openpty");

    let mut cmd = CommandBuilder::new("claude");
    cmd.arg("--output-format=stream-json");
    cmd.arg("--input-format=stream-json");

    let mut child = pair.slave.spawn_command(cmd).expect("spawn");
    drop(pair.slave);

    let mut writer = pair.master.take_writer().expect("writer");
    let mut reader = pair.master.try_clone_reader().expect("reader");

    let user_line = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"reply with the literal word ECHO"}]}}"#;
    writeln!(writer, "{}", user_line).unwrap();
    writer.flush().unwrap();

    let mut buf = [0u8; 4096];
    let mut total = Vec::new();
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(10) {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => total.extend_from_slice(&buf[..n]),
            Err(_) => std::thread::sleep(Duration::from_millis(50)),
        }
        if total.len() > 2048 { break; }
    }

    let _ = child.kill();
    let s = String::from_utf8_lossy(&total);
    println!("=== captured output (len={}) ===", total.len());
    println!("{}", s);

    let any_stream_json = s.lines().any(|line| {
        serde_json::from_str::<serde_json::Value>(line.trim())
            .ok()
            .and_then(|v| v.get("type").cloned())
            .is_some()
    });
    assert!(any_stream_json, "Path A FAILED - no stream-json lines detected. Switch to Path B (ANSI parser).");
}

/// Sanity check: --print + stream-json should work one-shot.
/// Uses std::process::Command (no PTY) since -p is non-interactive.
#[test]
#[ignore]
fn print_mode_stream_json_works() {
    let output = std::process::Command::new("claude")
        .arg("-p")
        .arg("--output-format=stream-json")
        .arg("--verbose") // stream-json requires --verbose
        .arg("reply with the literal word ECHO and nothing else")
        .output()
        .expect("spawn claude -p");

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    println!("=== stdout (len={}) ===\n{}", output.stdout.len(), stdout);
    if !stderr.is_empty() {
        println!("=== stderr (len={}) ===\n{}", output.stderr.len(), stderr);
    }
    println!("=== exit: {:?} ===", output.status);

    let fixture = fixture_dir().join("print_stream_json.txt");
    fs::write(&fixture, &output.stdout).expect("write fixture");
    println!("=== wrote fixture: {} ===", fixture.display());

    let stream_json_lines: Vec<&str> = stdout.lines().filter(|line| {
        serde_json::from_str::<serde_json::Value>(line.trim())
            .ok()
            .and_then(|v| v.get("type").cloned())
            .is_some()
    }).collect();

    assert!(
        !stream_json_lines.is_empty(),
        "no stream-json lines detected; print mode also broken (deeper problem)"
    );
}

/// Capture the first ~5s of interactive `claude` startup output.
/// Yields the welcome banner, prompt rendering, and any cursor escapes — the
/// minimum corpus the ANSI parser must learn to skip.
#[test]
#[ignore]
fn capture_interactive_startup_fixture() {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows: 50, cols: 200, pixel_width: 0, pixel_height: 0 })
        .expect("openpty");

    let cmd = CommandBuilder::new("claude");
    let mut child = pair.slave.spawn_command(cmd).expect("spawn");
    drop(pair.slave);

    let reader = pair.master.try_clone_reader().expect("reader");
    let total = drain_pty_for(reader, Duration::from_secs(5), 256 * 1024);
    let _ = child.kill();
    let _ = child.wait();

    let raw = fixture_dir().join("interactive_startup.bin");
    fs::write(&raw, &total).expect("write raw fixture");

    let s = String::from_utf8_lossy(&total);
    let summary = fixture_dir().join("interactive_startup_summary.txt");
    let summary_text = format!(
        "captured {} bytes\nfirst 4KB lossy:\n----------\n{}\n----------\n",
        total.len(),
        &s.chars().take(4096).collect::<String>()
    );
    fs::write(&summary, summary_text).expect("write summary");

    println!("=== wrote raw bytes: {} ({} bytes) ===", raw.display(), total.len());
    println!("=== wrote lossy summary: {} ===", summary.display());

    assert!(total.len() > 100, "claude produced barely any output - is it on PATH and responsive?");
}

/// Send a prompt to interactive claude and capture the full response cycle.
/// Most useful fixture for parser design - shows assistant streaming, tool blocks,
/// and prompt-echo behaviour we need to disambiguate.
#[test]
#[ignore]
fn capture_interactive_one_turn_fixture() {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows: 50, cols: 200, pixel_width: 0, pixel_height: 0 })
        .expect("openpty");

    let cmd = CommandBuilder::new("claude");
    let mut child = pair.slave.spawn_command(cmd).expect("spawn");
    drop(pair.slave);

    let mut writer = pair.master.take_writer().expect("writer");
    let reader = pair.master.try_clone_reader().expect("reader");

    // Let startup banner/prompt settle, then send the prompt, then drain the
    // whole cycle in one call (since drain_pty_for now takes ownership).
    std::thread::sleep(Duration::from_secs(2));
    writeln!(writer, "reply with the literal word ECHO and nothing else").expect("write");
    writer.flush().expect("flush");

    let total = drain_pty_for(reader, Duration::from_secs(30), 256 * 1024);
    let _ = child.kill();
    let _ = child.wait();

    let raw = fixture_dir().join("interactive_one_turn.bin");
    fs::write(&raw, &total).expect("write raw fixture");

    let summary = fixture_dir().join("interactive_one_turn_summary.txt");
    let summary_text = format!(
        "total bytes: {}\n\nfirst 8KB lossy:\n----------\n{}\n----------\n",
        total.len(),
        String::from_utf8_lossy(&total).chars().take(8192).collect::<String>()
    );
    fs::write(&summary, summary_text).expect("write summary");

    println!("=== wrote {} ({} total bytes) ===", raw.display(), total.len());

    assert!(total.len() > 100, "no output received - claude may have hung waiting on TUI input");
}

/// Path C spike: confirm `claude -p --resume <id>` keeps session continuity
/// without a persistent process. If yes, we can avoid the ANSI parser entirely
/// by treating each user turn as a -p invocation.
#[test]
#[ignore]
fn print_mode_resume_keeps_session_continuity() {
    let prompt1 = "remember the number 7. reply with only the word OK.";
    let out1 = std::process::Command::new("claude")
        .arg("-p")
        .arg("--output-format=stream-json")
        .arg("--verbose")
        .arg(prompt1)
        .output()
        .expect("spawn claude -p turn 1");
    assert!(out1.status.success(), "turn 1 failed");

    // Extract session_id from the result line.
    let s1 = String::from_utf8_lossy(&out1.stdout);
    let session_id = s1
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line.trim()).ok())
        .find_map(|v| {
            v.get("type")
                .and_then(|t| t.as_str())
                .filter(|t| *t == "result")
                .and_then(|_| v.get("session_id").and_then(|s| s.as_str()).map(String::from))
        })
        .expect("turn 1 emitted no result with session_id");

    let fixture = fixture_dir().join("print_resume_turn1.txt");
    fs::write(&fixture, &out1.stdout).expect("write turn 1");
    println!("=== turn 1 session_id: {} ({} bytes) ===", session_id, out1.stdout.len());

    // Turn 2: same session, ask what the number was.
    let prompt2 = "what number did i ask you to remember? reply with only the digit.";
    let out2 = std::process::Command::new("claude")
        .arg("-p")
        .arg("--resume")
        .arg(&session_id)
        .arg("--output-format=stream-json")
        .arg("--verbose")
        .arg(prompt2)
        .output()
        .expect("spawn claude -p turn 2");
    assert!(out2.status.success(), "turn 2 failed");

    let s2 = String::from_utf8_lossy(&out2.stdout);
    let fixture2 = fixture_dir().join("print_resume_turn2.txt");
    fs::write(&fixture2, &out2.stdout).expect("write turn 2");
    println!("=== turn 2 ({} bytes) ===", out2.stdout.len());

    // Confirm assistant in turn 2 actually remembered "7".
    let answer = s2
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line.trim()).ok())
        .find_map(|v| {
            if v.get("type").and_then(|t| t.as_str()) == Some("result") {
                v.get("result").and_then(|r| r.as_str()).map(String::from)
            } else {
                None
            }
        })
        .expect("turn 2 emitted no final result");

    println!("=== turn 2 answer: {} ===", answer.trim());
    assert!(
        answer.contains('7'),
        "session continuity broken - turn 2 didn't recall '7' (got: {:?})",
        answer
    );
}

/// Verify --resume <session-id> works in interactive PTY mode (for the takeover
/// flow if Path B is taken). Reads the most recent session id from
/// ~/.claude/sessions/*.json and resumes it.
#[test]
#[ignore]
fn resume_session_works() {
    let home = dirs::home_dir().expect("home");
    let sessions_dir = home.join(".claude").join("sessions");
    if !sessions_dir.exists() {
        println!("SKIP: no ~/.claude/sessions/ directory; need at least one prior session");
        return;
    }

    let mut newest: Option<(PathBuf, std::time::SystemTime)> = None;
    for entry in fs::read_dir(&sessions_dir).expect("read sessions dir") {
        let entry = entry.expect("entry");
        let path = entry.path();
        if path.extension().map(|e| e == "jsonl").unwrap_or(false) {
            let modified = entry.metadata().and_then(|m| m.modified()).ok();
            if let Some(t) = modified {
                if newest.as_ref().map(|(_, prev)| t > *prev).unwrap_or(true) {
                    newest = Some((path, t));
                }
            }
        }
    }
    let session_path = match newest {
        Some((p, _)) => p,
        None => {
            println!("SKIP: no .jsonl session files in ~/.claude/sessions/");
            return;
        }
    };
    let session_id = session_path
        .file_stem()
        .and_then(|s| s.to_str())
        .expect("session_id from filename")
        .to_string();
    println!("resuming session: {}", session_id);

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows: 50, cols: 200, pixel_width: 0, pixel_height: 0 })
        .expect("openpty");

    let mut cmd = CommandBuilder::new("claude");
    cmd.arg("--resume");
    cmd.arg(&session_id);
    let mut child = pair.slave.spawn_command(cmd).expect("spawn");
    drop(pair.slave);

    let reader = pair.master.try_clone_reader().expect("reader");
    let total = drain_pty_for(reader, Duration::from_secs(8), 256 * 1024);
    let _ = child.kill();
    let _ = child.wait();

    let raw = fixture_dir().join("interactive_resume.bin");
    fs::write(&raw, &total).expect("write raw fixture");

    println!("=== resume captured {} bytes -> {} ===", total.len(), raw.display());
    assert!(total.len() > 100, "resume produced no output - --resume may not work or session_id is wrong");
}
