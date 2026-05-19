//! Daemon-side detector reconcile task. Every 5s walks live PIDs and marks
//! ended instances; publishes `instances_changed` on every mutation.

use crate::daemon::state::DaemonState;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;

pub fn spawn(state: Arc<DaemonState>) {
    let registry = state.registry.clone();
    let notifier = state.notifier.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(5));
        loop {
            ticker.tick().await;
            let changed = crate::sessions::detector::reconcile_once(&registry);
            if changed {
                notifier.publish("instances_changed", json!({"instances": registry.list()}));
            }
        }
    });
}
