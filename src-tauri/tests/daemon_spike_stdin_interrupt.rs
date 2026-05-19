//! Spike: does claude CLI honor a stdin `{"type":"interrupt"}` JSON line in
//! stream-json input mode to abort the current turn without killing the
//! process?
//!
//! Manual-run only. Invoke with:
//!   cargo test --manifest-path src-tauri/Cargo.toml --test daemon_spike_stdin_interrupt -- --ignored --nocapture

#![cfg(windows)]

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[test]
#[ignore]
fn stdin_interrupt_aborts_turn_without_killing_process() {
    let mut child = Command::new("claude")
        .args([
            "-p",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--verbose",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn claude");

    let stdin = child.stdin.take().expect("stdin");
    let stdout = child.stdout.take().expect("stdout");

    let drain = thread::spawn(move || {
        let mut interrupted = false;
        let mut result_count = 0;
        for line in BufReader::new(stdout).lines().flatten() {
            eprintln!("[stdout] {line}");
            if line.contains("\"type\":\"result\"") {
                result_count += 1;
            }
            if line.contains("interrupt") || line.contains("aborted") {
                interrupted = true;
            }
        }
        (interrupted, result_count)
    });

    let mut stdin = stdin;
    writeln!(
        stdin,
        r#"{{"type":"user","message":{{"role":"user","content":"count from 1 to 200 with a tiny pause between numbers, output the full list"}}}}"#
    ).expect("write turn 1");
    stdin.flush().unwrap();

    thread::sleep(Duration::from_millis(3000));
    let _ = writeln!(stdin, r#"{{"type":"interrupt"}}"#);
    let _ = stdin.flush();

    let deadline = Instant::now() + Duration::from_secs(20);
    let mut still_alive_after_interrupt = false;
    while Instant::now() < deadline {
        match child.try_wait().expect("try_wait") {
            Some(_) => break,
            None => {
                still_alive_after_interrupt = true;
                thread::sleep(Duration::from_millis(250));
            }
        }
    }

    let _ = child.kill();
    let _ = child.wait();
    let (_interrupted_seen, result_count) = drain.join().unwrap();

    eprintln!("---- SPIKE A RESULT ----");
    eprintln!("process still alive after interrupt for full window: {still_alive_after_interrupt}");
    eprintln!("result events observed: {result_count}");
    eprintln!("If process stayed alive AND result count == 1 with truncated output, stdin-interrupt is supported.");
    eprintln!("If process exited after the interrupt frame, stdin-interrupt is NOT supported.");
    eprintln!("If neither happened (no result, no exit), the interrupt sentinel was ignored.");
}
