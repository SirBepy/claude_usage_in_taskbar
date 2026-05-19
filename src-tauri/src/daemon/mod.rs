//! Daemon-side modules. The binary at `src/bin/cc_companion_daemon.rs`
//! consumes these via the `claude_usage_tauri_lib` library crate.

pub mod broadcast;
pub mod frame;
pub mod handshake;
pub mod health;
pub mod jsonl_tail;
pub mod lifecycle;
pub mod lockfile;
pub mod methods;
pub mod notifier;
pub mod rpc;
pub mod session;
pub mod settings_cache;

#[cfg(windows)]
pub mod transport_windows;
