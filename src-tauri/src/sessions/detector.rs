//! Periodic reconciliation between the instance registry and the
//! live process list. Catches instances that died without firing a
//! `SessionEnd` hook (force-kill, crash, window-close with dirty
//! state).

use crate::sessions::kinds::InstanceKind;
use crate::sessions::registry::Registry;
use crate::types::EndReason;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use sysinfo::System;
use tauri::{AppHandle, Emitter, Manager};

/// Pure reconciliation step for testability.
pub struct ReconcileInput<'a> {
    pub live_pids: Vec<u32>,
    pub now: &'a str,
    pub absent_strikes: &'a mut HashMap<String, u8>,
    pub grace_period_secs: u64, // not applied here; plumbed for parity w/ design
}

/// Applies the 2-strikes-and-you're-out rule. Returns the session IDs
/// that were newly marked as ended this tick.
pub fn reconcile(registry: &Registry, input: ReconcileInput) -> Vec<String> {
    let instances = registry.list();
    let live: std::collections::HashSet<u32> = input.live_pids.into_iter().collect();
    let mut ended_now = Vec::new();

    for i in instances {
        // Skip already-ended instances.
        if i.end_reason.is_some() { continue; }
        // Skip unknown PIDs (pid = 0 when the hook didn't include it).
        if i.pid == 0 { continue; }
        // Skip Interactive sessions (Path C). The pid stored on these is the
        // claude.exe process from the FIRST -p turn, which exits as soon as
        // the turn finishes. Reconciliation would mark the session ended
        // 10s after the first reply, even though the user can keep sending
        // turns. Lifecycle for Interactive is owned by the chat IPC layer
        // (start_session / cancel_turn / app-quit cleanup), not the OS poll.
        if i.kind == InstanceKind::Interactive { continue; }
        if live.contains(&i.pid) {
            input.absent_strikes.remove(&i.session_id);
            continue;
        }
        let strikes = input.absent_strikes.entry(i.session_id.clone()).or_insert(0);
        *strikes += 1;
        if *strikes >= 2 {
            if registry.mark_ended(&i.session_id, EndReason::ProcessGone, input.now) {
                ended_now.push(i.session_id.clone());
            }
            input.absent_strikes.remove(&i.session_id);
        }
    }
    ended_now
}

/// One reconciliation tick: refreshes the live process list and applies the
/// 2-strikes-and-you're-out rule against the registry. Strike state persists
/// across calls via an internal `Mutex<HashMap>` so callers can invoke this
/// from a simple loop without threading state through.
///
/// Returns `true` if any instance was newly marked ended this tick.
pub fn reconcile_once(registry: &Registry) -> bool {
    static STRIKES: std::sync::OnceLock<Mutex<HashMap<String, u8>>> = std::sync::OnceLock::new();
    let strikes_mu = STRIKES.get_or_init(|| Mutex::new(HashMap::new()));

    let mut sys = System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All);
    let live_pids: Vec<u32> = sys.processes().keys().map(|p| p.as_u32()).collect();
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);

    let mut strikes = strikes_mu.lock().expect("strikes mutex poisoned");
    let ended_now = reconcile(registry, ReconcileInput {
        live_pids,
        now: &now,
        absent_strikes: &mut *strikes,
        grace_period_secs: 30,
    });
    !ended_now.is_empty()
}

/// Background task that runs the reconciliation every 5s and prunes
/// long-ended instances every 60s.
///
/// Daemon-pivot Phase 3: the daemon now owns the registry and runs its own
/// reconcile loop (`daemon::detector`). This app-side stub is kept so the
/// existing `spawn(detector::run(h))` call site stays valid; it never wakes.
pub async fn run(_app: AppHandle) {
    // No-op. See module doc.
    std::future::pending::<()>().await;
}
