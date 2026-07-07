//! Pre-spawn drift guard: refuses to spawn if a profile dir's CLI identity no
//! longer matches what the registry recorded at add-account time (someone ran
//! `/login` inside that dir since onboarding, silently rebinding it to a
//! different account). See `docs/multi-account/02-chat-routing.md` step 3b.

use super::identity::{self, OauthAccountInfo};
use super::model::Account;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum DriftError {
    #[error("\"{label}\" has no CLI login yet at {config_dir} - run /login inside it first")]
    NotLoggedIn { label: String, config_dir: String },
    #[error("\"{label}\" is now logged in as {actual_email} (registered as {expected_email}) - re-verify the account before chatting")]
    Mismatch {
        label: String,
        expected_email: String,
        actual_email: String,
    },
}

/// Compares the account's PROFILE DIR identity (what `/login` actually left
/// behind) against the REGISTRY record (what the wizard verified at
/// add-account time). Pure comparison logic over an already-read identity so
/// it is testable without touching disk.
pub fn compare(account: &Account, current_identity: Option<&OauthAccountInfo>) -> Result<(), DriftError> {
    let identity = match current_identity {
        Some(i) => i,
        None => {
            return Err(DriftError::NotLoggedIn {
                label: account.label.clone(),
                config_dir: account.config_dir.display().to_string(),
            })
        }
    };
    let mismatch = identity.organization_uuid != account.org_uuid
        || !identity.email_address.eq_ignore_ascii_case(&account.email);
    if mismatch {
        return Err(DriftError::Mismatch {
            label: account.label.clone(),
            expected_email: account.email.clone(),
            actual_email: identity.email_address.clone(),
        });
    }
    Ok(())
}

/// Reads `<account.config_dir>/.claude.json` and runs [`compare`]. The
/// disk-read / comparison split keeps `compare` a pure unit-testable
/// function.
pub fn check(account: &Account) -> Result<(), DriftError> {
    let identity = identity::read_oauth_account(&account.config_dir);
    compare(account, identity.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn acct() -> Account {
        Account {
            id: "id-1".into(),
            label: "Work".into(),
            colour: "#fff".into(),
            icon: "user".into(),
            config_dir: PathBuf::from("C:/home/.claude-work"),
            chrome_profile_dir: PathBuf::from("C:/appdata/chrome-profiles/id-1"),
            email: "work@example.com".into(),
            org_uuid: "org-work".into(),
            subscription_tier: "claude_max".into(),
            created_at: "2026-07-07T00:00:00Z".into(),
        }
    }

    fn identity(email: &str, org_uuid: &str) -> OauthAccountInfo {
        OauthAccountInfo {
            email_address: email.into(),
            organization_uuid: org_uuid.into(),
            organization_name: None,
            organization_type: None,
            profile_fetched_at: None,
        }
    }

    #[test]
    fn matching_identity_passes() {
        let a = acct();
        let id = identity("work@example.com", "org-work");
        assert!(compare(&a, Some(&id)).is_ok());
    }

    #[test]
    fn matching_identity_is_case_insensitive_on_email() {
        let a = acct();
        let id = identity("WORK@EXAMPLE.COM", "org-work");
        assert!(compare(&a, Some(&id)).is_ok());
    }

    #[test]
    fn org_uuid_mismatch_is_drift() {
        let a = acct();
        let id = identity("work@example.com", "org-someone-else");
        let err = compare(&a, Some(&id)).unwrap_err();
        assert!(matches!(err, DriftError::Mismatch { .. }));
    }

    #[test]
    fn email_mismatch_is_drift() {
        let a = acct();
        let id = identity("someone-else@example.com", "org-work");
        let err = compare(&a, Some(&id)).unwrap_err();
        assert!(matches!(err, DriftError::Mismatch { .. }));
    }

    #[test]
    fn missing_identity_is_not_logged_in() {
        let a = acct();
        let err = compare(&a, None).unwrap_err();
        assert!(matches!(err, DriftError::NotLoggedIn { .. }));
    }

    #[test]
    fn check_reads_from_config_dir_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let mut a = acct();
        a.config_dir = dir.path().to_path_buf();
        // No .claude.json yet -> not logged in.
        assert!(matches!(check(&a).unwrap_err(), DriftError::NotLoggedIn { .. }));

        std::fs::write(
            dir.path().join(".claude.json"),
            r#"{"oauthAccount": {"emailAddress": "work@example.com", "organizationUuid": "org-work"}}"#,
        )
        .unwrap();
        assert!(check(&a).is_ok());
    }
}
