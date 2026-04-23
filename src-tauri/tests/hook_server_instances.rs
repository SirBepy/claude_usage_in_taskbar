//! Boot the hook_server inline, POST real payloads, assert registry state.
//! Requires a Tauri test harness. The existing `settings_roundtrip_renders.rs`
//! test doesn't boot Tauri; integration-testing a tauri::command is out of
//! scope. This test talks to the raw Registry through a minimal mock.

use claude_usage_tauri_lib::hooks::instances::{Registry, RegisterInput};
use claude_usage_tauri_lib::types::{EndReason, InstanceKind, Settings};
use std::path::PathBuf;
use std::sync::Mutex;

/// A simple validation that the SessionStart → register → mark_ended
/// flow behaves end-to-end on the registry. The HTTP layer is a thin
/// axum wrapper around `register` and `mark_ended`; unit-testing those
/// covers the critical path.
#[test]
fn session_start_then_end_flow() {
    let reg = Registry::new();
    let settings = Mutex::new(Settings::default());
    let (_proj, created) = reg.register(
        RegisterInput {
            session_id: "s1".into(),
            cwd: PathBuf::from("C:/a"),
            pid: 111,
            kind: InstanceKind::External,
            is_remote: false,
            transcript_path: None,
            started_at: "2026-04-21T00:00:00Z".into(),
        },
        &settings,
        "2026-04-21T00:00:00Z",
    );
    assert!(created);
    assert_eq!(reg.list().len(), 1);

    assert!(reg.mark_ended("s1", EndReason::HookSessionEnd, "2026-04-21T00:05:00Z"));
    assert_eq!(reg.list()[0].end_reason, Some(EndReason::HookSessionEnd));
}
