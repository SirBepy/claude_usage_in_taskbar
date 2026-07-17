//! Daemon instance identity. The production daemon is a singleton keyed by the
//! current user. Tests set `CC_DAEMON_INSTANCE` to a label so the spawned test
//! daemon uses a DISTINCT pipe name, lockfile, and hook port - never colliding
//! with (or killing) a real `cc-conductor-daemon` the user has running.
//! See ai_todo 71.
//!
//! A `cargo tauri dev` (debug) build FALLS BACK to its own `-dev` identity
//! (incident 2026-07-16: a debug instance took over the production daemon's
//! port/pipe/lock, bouncing the user's live chats) but only when it can't
//! attach to an already-running daemon. Most dev work never touches the
//! daemon's own Rust code - it's UI/app-side only - so `daemon_client::
//! ensure_daemon` tries the production (unsuffixed) pipe FIRST and calls
//! `mark_attached_to_existing()` on success: real live data, zero daemon
//! duplication, and every other suffix-aware path (hook-port file, session
//! file) automatically agrees since they all route through this one
//! function. The `-dev` fallback only fires when nothing is running, or when
//! `CC_DEV_OWN_DAEMON` forces an isolated daemon on purpose (testing an
//! actual daemon-side change). Every e2e/wdio test entry point sets
//! `CC_DAEMON_INSTANCE` explicitly, which skips the attach attempt entirely -
//! test isolation is unaffected either way.

use std::sync::atomic::{AtomicBool, Ordering};

static ATTACHED_TO_EXISTING: AtomicBool = AtomicBool::new(false);

/// Called once, by `daemon_client::ensure_daemon`, right after a debug build
/// successfully connects to the already-running (production) daemon instead
/// of spawning its own. From that point on `instance_suffix()` returns empty
/// for the rest of this process's life.
pub fn mark_attached_to_existing() {
    ATTACHED_TO_EXISTING.store(true, Ordering::SeqCst);
}

/// Optional instance suffix, e.g. `-test` or `-dev`, derived from (in order):
/// having attached to an existing daemon this run (`mark_attached_to_existing`,
/// always wins - empty), `CC_DAEMON_INSTANCE` (explicit override), or, failing
/// both, `cfg!(debug_assertions)` (debug builds default to `-dev`). Empty
/// string only for a real release/production build, or a debug build that
/// attached to one. Both the daemon side (pipe bind, lockfile, hook port) and
/// the app-side client must agree, so they all route through this one helper.
pub fn instance_suffix() -> String {
    if ATTACHED_TO_EXISTING.load(Ordering::SeqCst) {
        return String::new();
    }
    match std::env::var("CC_DAEMON_INSTANCE") {
        Ok(v) if !v.is_empty() => return format!("-{v}"),
        _ => {}
    }
    if cfg!(debug_assertions) { return "-dev".to_string(); }
    String::new()
}
