//! Multi-account identity: the `Account` record, its persisted registry, the
//! per-account `CLAUDE_CONFIG_DIR` profile-dir factory, and `.claude.json`
//! identity parsing. See `docs/multi-account/00-overview.md` (locked
//! decisions) and `docs/multi-account/01-account-identity.md` (this
//! milestone's spec).

pub mod model;
pub mod store;
pub mod identity;
pub mod profile;
pub mod login_step;
pub mod wizard;

pub use model::*;
pub use identity::{terminal_identity, OauthAccountInfo};
pub use wizard::WizardSession;
