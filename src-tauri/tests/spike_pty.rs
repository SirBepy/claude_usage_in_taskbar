//! Phase 0 spike: confirm whether claude CLI supports stream-json in interactive PTY mode.
//! Gated behind --ignored; manual run only:
//!   cargo test -p claude-usage-tauri-lib --test spike_pty -- --ignored --nocapture

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::time::{Duration, Instant};

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
