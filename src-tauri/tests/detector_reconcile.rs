use claude_usage_tauri_lib::hooks::detector::{ReconcileInput, reconcile};
use claude_usage_tauri_lib::hooks::instances::{Registry, RegisterInput};
use claude_usage_tauri_lib::types::{EndReason, InstanceKind, Settings};
use std::path::PathBuf;
use std::sync::Mutex;

fn seed(sid: &str, pid: u32) -> RegisterInput {
    RegisterInput {
        session_id: sid.into(),
        cwd: PathBuf::from("C:/x"),
        pid,
        kind: InstanceKind::External,
        is_remote: false,
        transcript_path: None,
        started_at: "2026-04-21T00:00:00Z".into(),
    }
}

#[test]
fn single_missing_tick_does_not_mark_dead() {
    let r = Registry::new();
    let settings = Mutex::new(Settings::default());
    r.register(seed("s1", 111), &settings, "2026-04-21T00:00:00Z");
    // First tick: pid not present
    let ended = reconcile(&r, ReconcileInput {
        live_pids: vec![], // empty
        now: "2026-04-21T00:00:10Z",
        absent_strikes: &mut std::collections::HashMap::new(),
        grace_period_secs: 0,
    });
    assert!(ended.is_empty());
}

#[test]
fn two_consecutive_missing_ticks_mark_dead() {
    let r = Registry::new();
    let settings = Mutex::new(Settings::default());
    r.register(seed("s1", 111), &settings, "2026-04-21T00:00:00Z");
    let mut strikes = std::collections::HashMap::new();
    reconcile(&r, ReconcileInput {
        live_pids: vec![],
        now: "2026-04-21T00:00:10Z",
        absent_strikes: &mut strikes,
        grace_period_secs: 0,
    });
    let ended = reconcile(&r, ReconcileInput {
        live_pids: vec![],
        now: "2026-04-21T00:00:15Z",
        absent_strikes: &mut strikes,
        grace_period_secs: 0,
    });
    assert_eq!(ended, vec!["s1".to_string()]);
    let got = &r.list()[0];
    assert_eq!(got.end_reason, Some(EndReason::ProcessGone));
}

#[test]
fn live_pid_resets_strike_count() {
    let r = Registry::new();
    let settings = Mutex::new(Settings::default());
    r.register(seed("s1", 111), &settings, "2026-04-21T00:00:00Z");
    let mut strikes = std::collections::HashMap::new();
    reconcile(&r, ReconcileInput { live_pids: vec![], now: "t1", absent_strikes: &mut strikes, grace_period_secs: 0 });
    reconcile(&r, ReconcileInput { live_pids: vec![111], now: "t2", absent_strikes: &mut strikes, grace_period_secs: 0 });
    let ended = reconcile(&r, ReconcileInput {
        live_pids: vec![], now: "t3",
        absent_strikes: &mut strikes, grace_period_secs: 0,
    });
    assert!(ended.is_empty());
}
