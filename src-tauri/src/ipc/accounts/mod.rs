//! Add-account wizard IPC + account registry management (multi-account
//! milestone 01, backend only - see `docs/multi-account/01-account-identity.md`).
//!
//! Split by concern so no single file mixes unrelated command groups:
//! - `wizard` - the add-account flow (create/check-login/capture-cookie/
//!   cancel/finalize) and its session/outcome types.
//! - `management` - registry CRUD (list/remove/logout/update/set-default).
//! - `identity` - identity/drift read surfaces + reauth/recapture-cookie.
//! - `setup_prompt` - the one-time "set up your accounts" migration prompt.
//!
//! Each submodule is `pub use`-re-exported here so `crate::ipc::accounts::*`
//! call sites and `lib.rs`'s `generate_handler!` list keep working unchanged.

mod identity;
mod management;
mod setup_prompt;
mod wizard;

pub use identity::*;
pub use management::*;
pub use setup_prompt::*;
pub use wizard::*;
