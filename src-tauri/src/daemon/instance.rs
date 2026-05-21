//! Daemon instance identity. The production daemon is a singleton keyed by the
//! current user. Tests set `CC_DAEMON_INSTANCE` to a label so the spawned test
//! daemon uses a DISTINCT pipe name, lockfile, and hook port - never colliding
//! with (or killing) a real `cc-companion-daemon` the user has running.
//! See ai_todo 71.

/// Optional instance suffix, e.g. `-test`, derived from `CC_DAEMON_INSTANCE`.
/// Empty string for the default (production) instance. Both the daemon side
/// (pipe bind, lockfile, hook port) and the app-side client must agree, so they
/// all route through this one helper.
pub fn instance_suffix() -> String {
    match std::env::var("CC_DAEMON_INSTANCE") {
        Ok(v) if !v.is_empty() => format!("-{v}"),
        _ => String::new(),
    }
}

/// Whether a non-default (test) instance is active. When true, the hook server
/// binds an ephemeral port instead of the fixed `HOOK_PORT` so it never fights
/// the production daemon for 27182.
pub fn is_test_instance() -> bool {
    !instance_suffix().is_empty()
}
