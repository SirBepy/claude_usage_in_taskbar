//! Owns automated Claude Code channels. One `Channel` per project
//! that has `automation.enabled`. Spawn, kill, restart with
//! exponential backoff on early failure, and Windows console
//! show/hide via HWND manipulation.

pub mod spawn;
pub mod watchdog;
pub mod window_chrome;
pub mod kill;
pub mod vault_detector;
pub mod manager;
pub mod lifecycle;

pub use spawn::*;
pub use watchdog::*;
pub use window_chrome::*;
pub use kill::*;
pub use manager::*;
pub use lifecycle::*;
