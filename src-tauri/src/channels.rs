//! Owns automated Claude Code channels. One `Channel` per project
//! that has `automation.enabled`. Spawn once per dashboard launch,
//! kill on shutdown / manual stop. No auto-restart on exit (matches
//! the original obsidian_claude_remote behavior; auto-restarting on
//! every exit registered a fresh bridge with the Claude desktop app
//! every time, piling up duplicate sidebar entries).

pub mod spawn;
pub mod window_chrome;
pub mod kill;
pub mod vault_detector;
pub mod manager;

pub use spawn::*;
pub use window_chrome::*;
pub use kill::*;
pub use manager::*;
