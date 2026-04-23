use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestartDecision {
    DoNotRestart,
    RestartAfter(Duration),
    GiveUp,
}

#[derive(Debug, Default, Clone)]
pub struct RestartState {
    pub early_exits_in_a_row: u32,
    pub cap_failures: u32,
    pub suppress_restart: bool,
}

const STABLE_THRESHOLD_SECS: u64 = 5;
const BACKOFFS_SECS: [u64; 4] = [2, 4, 8, 16];
const MAX_CAP_FAILURES: u32 = 5;

pub fn next_restart_delay(state: &mut RestartState, last_runtime: Duration) -> RestartDecision {
    if state.suppress_restart {
        return RestartDecision::DoNotRestart;
    }

    if last_runtime.as_secs() >= STABLE_THRESHOLD_SECS {
        state.early_exits_in_a_row = 0;
        state.cap_failures = 0;
        return RestartDecision::RestartAfter(Duration::from_secs(0));
    }

    if (state.early_exits_in_a_row as usize) < BACKOFFS_SECS.len() {
        let delay = BACKOFFS_SECS[state.early_exits_in_a_row as usize];
        state.early_exits_in_a_row += 1;
        return RestartDecision::RestartAfter(Duration::from_secs(delay));
    }
    state.cap_failures += 1;
    if state.cap_failures >= MAX_CAP_FAILURES {
        return RestartDecision::GiveUp;
    }
    RestartDecision::RestartAfter(Duration::from_secs(*BACKOFFS_SECS.last().unwrap()))
}
