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
pub mod env;
pub mod drift;

pub use model::*;
pub use identity::{terminal_identity, OauthAccountInfo};
pub use wizard::WizardSession;

/// Errors resolving which registered `Account` a spawn should run under. See
/// `docs/multi-account/02-chat-routing.md`: "There is no no-override spawn
/// path: a chat REQUIRES a registry account."
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AccountResolveError {
    #[error("no accounts registered - add an account before starting a chat")]
    NoAccounts,
    #[error("account {0} not found in the registry")]
    NotFound(String),
}

/// Loads the on-disk accounts registry. Empty (never panics) if the path
/// can't be resolved or the file is missing/corrupt - mirrors `store::load`.
fn load_registry() -> Vec<model::Account> {
    match crate::settings::paths::accounts_file() {
        Ok(p) => store::load(&p),
        Err(_) => Vec::new(),
    }
}

/// Pure matching logic behind [`resolve_account`], split out so it is
/// testable without touching disk: `account_id` if given, else
/// `default_account_id`, looked up in an already-loaded registry slice.
fn pick_account(
    accounts: &[model::Account],
    account_id: Option<&str>,
    default_account_id: Option<&str>,
) -> Result<model::Account, AccountResolveError> {
    if accounts.is_empty() {
        return Err(AccountResolveError::NoAccounts);
    }
    let want = account_id
        .or(default_account_id)
        .ok_or(AccountResolveError::NoAccounts)?;
    accounts
        .iter()
        .find(|a| a.id == want)
        .cloned()
        .ok_or_else(|| AccountResolveError::NotFound(want.to_string()))
}

/// Resolves the account a spawn should run under: `account_id` if given,
/// else `default_account_id`. Shared by every spawn site so "no spawn path
/// reaches `~/.claude`" holds uniformly regardless of caller.
pub fn resolve_account(
    account_id: Option<&str>,
    default_account_id: Option<&str>,
) -> Result<model::Account, AccountResolveError> {
    pick_account(&load_registry(), account_id, default_account_id)
}

/// Convenience wrapper for spawn sites that have no per-instance account
/// selection yet (channels, the news summarizer): resolves purely from
/// `Settings.default_account_id`, re-reading `settings.json` from disk since
/// these callers hold no live settings cache. Never falls back to
/// `~/.claude` - an unresolvable default means the caller skips/refuses.
pub fn resolve_default_account() -> Result<model::Account, AccountResolveError> {
    let settings_path =
        crate::settings::paths::settings_file().map_err(|_| AccountResolveError::NoAccounts)?;
    let settings = crate::settings::load(&settings_path);
    resolve_account(None, settings.default_account_id.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acct(id: &str) -> model::Account {
        model::Account {
            id: id.into(),
            label: id.into(),
            colour: "#fff".into(),
            icon: "user".into(),
            config_dir: std::path::PathBuf::from(format!("C:/home/.claude-{id}")),
            chrome_profile_dir: std::path::PathBuf::from(format!("C:/appdata/chrome-profiles/{id}")),
            email: format!("{id}@example.com"),
            org_uuid: format!("org-{id}"),
            subscription_tier: "claude_max".into(),
            created_at: "2026-07-07T00:00:00Z".into(),
        }
    }

    #[test]
    fn pick_account_empty_registry_is_no_accounts() {
        let err = pick_account(&[], None, None).unwrap_err();
        assert_eq!(err, AccountResolveError::NoAccounts);
    }

    #[test]
    fn pick_account_no_id_and_no_default_is_no_accounts() {
        let accounts = vec![acct("a")];
        let err = pick_account(&accounts, None, None).unwrap_err();
        assert_eq!(err, AccountResolveError::NoAccounts);
    }

    #[test]
    fn pick_account_explicit_id_wins_over_default() {
        let accounts = vec![acct("a"), acct("b")];
        let got = pick_account(&accounts, Some("b"), Some("a")).unwrap();
        assert_eq!(got.id, "b");
    }

    #[test]
    fn pick_account_falls_back_to_default_when_no_explicit_id() {
        let accounts = vec![acct("a"), acct("b")];
        let got = pick_account(&accounts, None, Some("a")).unwrap();
        assert_eq!(got.id, "a");
    }

    #[test]
    fn pick_account_unknown_id_is_not_found() {
        let accounts = vec![acct("a")];
        let err = pick_account(&accounts, Some("ghost"), None).unwrap_err();
        assert_eq!(err, AccountResolveError::NotFound("ghost".to_string()));
    }
}
