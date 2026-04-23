//! Periodic reconciliation between the instance registry and the
//! live process list. Catches instances that died without firing a
//! `SessionEnd` hook (force-kill, crash, window-close with dirty
//! state).

use crate::instances::Registry;
use crate::types::EndReason;
use std::collections::HashMap;
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

/// Background task that runs the reconciliation every 5s and prunes
/// long-ended instances every 60s.
pub async fn run(app: AppHandle) {
    let mut strikes: HashMap<String, u8> = HashMap::new();
    let mut last_prune = tokio::time::Instant::now();
    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let mut sys = System::new();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All);
        let live_pids: Vec<u32> = sys.processes().keys().map(|p| p.as_u32()).collect();
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);

        let state = app.state::<crate::state::AppState>();
        let registry = state.instances.clone();
        let ended_now = reconcile(&registry, ReconcileInput {
            live_pids,
            now: &now,
            absent_strikes: &mut strikes,
            grace_period_secs: 30,
        });
        if !ended_now.is_empty() {
            let _ = app.emit("instances-changed", registry.list());
        }

        if last_prune.elapsed().as_secs() >= 60 {
            let cutoff = (chrono::Utc::now() - chrono::Duration::seconds(60))
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
            registry.prune_ended_before(&cutoff);
            last_prune = tokio::time::Instant::now();
            let _ = app.emit("instances-changed", registry.list());
        }
    }
}
