use claude_usage_tauri_lib::channels::{next_restart_delay, RestartDecision, RestartState};
use std::time::Duration;

#[test]
fn no_restart_when_user_stopped() {
    let mut st = RestartState::default();
    st.suppress_restart = true;
    let d = next_restart_delay(&mut st, Duration::from_secs(1));
    assert_eq!(d, RestartDecision::DoNotRestart);
}

#[test]
fn single_immediate_restart_after_stable_run() {
    let mut st = RestartState::default();
    let d = next_restart_delay(&mut st, Duration::from_secs(30));
    assert_eq!(d, RestartDecision::RestartAfter(Duration::from_secs(0)));
}

#[test]
fn exponential_backoff_when_failing_early() {
    let mut st = RestartState::default();
    // First early-exit triggers a 2s delay.
    let d1 = next_restart_delay(&mut st, Duration::from_secs(1));
    assert_eq!(d1, RestartDecision::RestartAfter(Duration::from_secs(2)));
    // Second early-exit: 4s.
    let d2 = next_restart_delay(&mut st, Duration::from_secs(1));
    assert_eq!(d2, RestartDecision::RestartAfter(Duration::from_secs(4)));
    // Third: 8s.
    let d3 = next_restart_delay(&mut st, Duration::from_secs(1));
    assert_eq!(d3, RestartDecision::RestartAfter(Duration::from_secs(8)));
    // Fourth: 16s.
    let d4 = next_restart_delay(&mut st, Duration::from_secs(1));
    assert_eq!(d4, RestartDecision::RestartAfter(Duration::from_secs(16)));
    // Fifth: 16s cap (no higher).
    let d5 = next_restart_delay(&mut st, Duration::from_secs(1));
    assert_eq!(d5, RestartDecision::RestartAfter(Duration::from_secs(16)));
}

#[test]
fn long_runtime_resets_backoff() {
    let mut st = RestartState::default();
    next_restart_delay(&mut st, Duration::from_secs(1));
    next_restart_delay(&mut st, Duration::from_secs(1));
    // 30s runtime resets counter.
    let d = next_restart_delay(&mut st, Duration::from_secs(30));
    assert_eq!(d, RestartDecision::RestartAfter(Duration::from_secs(0)));
}

#[test]
fn after_cap_and_still_failing_marks_crashed() {
    let mut st = RestartState::default();
    for _ in 0..4 { next_restart_delay(&mut st, Duration::from_secs(1)); }
    // Simulate 5 more cap-delay attempts all failing early -> give up.
    for _ in 0..5 {
        let d = next_restart_delay(&mut st, Duration::from_secs(1));
        match d {
            RestartDecision::RestartAfter(_) => continue,
            RestartDecision::GiveUp => return,
            _ => panic!("unexpected: {:?}", d),
        }
    }
    panic!("expected GiveUp after repeated cap-bucket failures");
}
