//! Add-account wizard IPC + account registry management (multi-account
//! milestone 01, backend only - see `docs/multi-account/01-account-identity.md`).
//!
//! Wizard flow: `add_account_create` (profile dir + spawn `/login` terminal)
//! -> poll `add_account_check_login` until `Ready` -> optionally
//! `add_account_capture_cookie` (web sessionKey + cross-check) ->
//! `add_account_finalize` (persist). `add_account_cancel` at any point cleans
//! up a dir THIS wizard run created (never an adopted pre-existing dir).

use crate::accounts::model::{slugify, Account};
use crate::accounts::{drift, identity, login_step, profile, store as accounts_store, OauthAccountInfo, WizardSession};
use crate::settings::paths;
use crate::state::AppState;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

fn home_claude_dir() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "could not resolve home dir".to_string())?;
    Ok(home.join(".claude"))
}

#[derive(Serialize, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct AddAccountSession {
    pub session_id: String,
    pub config_dir: std::path::PathBuf,
    /// True if `config_dir` already existed (adoption path). Only meaningful
    /// to the user when `existing_identity` is also set - a cancelled wizard
    /// run can leave an empty husk dir behind (the open terminal locks it
    /// against deletion), and adopting a husk is indistinguishable from a
    /// fresh add.
    pub adopted_existing: bool,
    pub existing_identity: Option<OauthAccountInfo>,
    /// True when the adopted dir already held a complete login (identity +
    /// credentials): no terminal was spawned, and the first
    /// `add_account_check_login` will come back `Ready` immediately.
    pub login_skipped: bool,
    /// The window title the spawned `/login` terminal was given (present iff
    /// a terminal was actually spawned), so the waiting UI can tell the user
    /// exactly which window to type into.
    pub terminal_title: Option<String>,
}

#[derive(Serialize, ts_rs::TS)]
#[serde(tag = "status")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum LoginCheckOutcome {
    /// No complete login observed in the profile dir yet; keep polling.
    /// `misdirected` carries a hint when a login was just observed landing in
    /// a DIFFERENT profile (wrong terminal) - a nudge, not a hard failure,
    /// since token auto-refresh also rewrites credentials files.
    /// `credentials_no_profile` is true when the dir already holds a valid
    /// `.credentials.json` but the CLI hasn't written `oauthAccount` yet - the
    /// user isn't stuck waiting on `/login`, they just haven't run an
    /// interactive turn in that terminal since.
    Pending { misdirected: Option<String>, credentials_no_profile: bool },
    /// A fresh, non-duplicate identity was observed - ready to capture the
    /// cookie and/or finalize.
    Ready { identity: OauthAccountInfo },
    /// The dir being adopted already belonged to a different account than
    /// the one that just logged in.
    Mismatch { existing_email: String, new_email: String },
    /// This org/email is already registered under another account.
    Duplicate { existing_label: String },
}

/// Step 1: create (or adopt) the profile dir and spawn the visible `/login`
/// terminal. `slug` defaults to a slugified `label` when omitted.
#[tauri::command]
pub fn add_account_create(
    label: String,
    slug: Option<String>,
    state: State<AppState>,
) -> Result<AddAccountSession, String> {
    let slug = slug.unwrap_or_else(|| slugify(&label));
    if slug.trim().is_empty() {
        return Err("slug must not be empty".to_string());
    }
    let home_claude = home_claude_dir()?;
    let outcome = profile::create_or_adopt_profile_dir(&home_claude, &slug)
        .map_err(|e| e.to_string())?;

    // A collision with an already-REGISTERED account's dir is a slug clash,
    // not a fresh add or a legitimate hand-built-dir adoption. Since that
    // dir already existed, create_or_adopt_profile_dir only filled in
    // (harmless, idempotent) missing links - nothing to clean up here.
    let accounts_path = paths::accounts_file().map_err(|e| e.to_string())?;
    let registered = accounts_store::load(&accounts_path);
    if registered.iter().any(|a| a.config_dir == outcome.config_dir) {
        return Err(format!("\"{slug}\" is already a registered account"));
    }

    let existing_identity = identity::read_oauth_account(&outcome.config_dir);

    // Adoption fast-path: a dir that already holds a complete login (identity
    // + credentials) needs NO /login - an expired access token still counts,
    // the CLI self-refreshes. Skip the terminal; the first check_login call
    // returns Ready with the existing identity for the user to confirm.
    let login_skipped = login_step::has_complete_login(&outcome.config_dir);
    let (login_watch, terminal_title) = if login_skipped {
        (login_step::LoginWatch::default(), None)
    } else {
        let watch = dirs::home_dir()
            .map(|home| login_step::capture_login_watch(&home, &outcome.config_dir))
            .unwrap_or_default();
        login_step::spawn_login_terminal(&outcome.config_dir, &slug).map_err(|e| e.to_string())?;
        (watch, Some(login_step::login_terminal_title(&slug)))
    };

    let account_id = uuid::Uuid::new_v4().to_string();
    let chrome_profile_dir =
        paths::account_chrome_profile_dir(&account_id).map_err(|e| e.to_string())?;
    let session_id = uuid::Uuid::new_v4().to_string();

    let result = AddAccountSession {
        session_id: session_id.clone(),
        config_dir: outcome.config_dir.clone(),
        adopted_existing: !outcome.created_new,
        existing_identity: existing_identity.clone(),
        login_skipped,
        terminal_title,
    };
    let session = WizardSession {
        account_id,
        slug,
        config_dir: outcome.config_dir,
        chrome_profile_dir,
        created_new_dir: outcome.created_new,
        pre_existing_identity: existing_identity,
        login_watch,
        verified_identity: None,
        session_key: None,
    };
    state.account_wizard_sessions.lock().unwrap().insert(session_id, session);
    Ok(result)
}

/// Step 2: poll for a fresh `oauthAccount`. Call repeatedly until it stops
/// returning `Pending` (or the user cancels / a frontend-owned timeout
/// fires `add_account_cancel`).
#[tauri::command]
pub fn add_account_check_login(
    session_id: String,
    state: State<AppState>,
) -> Result<LoginCheckOutcome, String> {
    let mut sessions = state.account_wizard_sessions.lock().unwrap();
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "wizard session not found or already finished".to_string())?;

    let identity = match login_step::poll_login(&session.config_dir) {
        login_step::LoginPollResult::Pending => {
            return Ok(LoginCheckOutcome::Pending {
                misdirected: login_step::detect_misdirected_login(&session.login_watch),
                credentials_no_profile: false,
            })
        }
        login_step::LoginPollResult::CredentialsNoProfile => {
            return Ok(LoginCheckOutcome::Pending {
                misdirected: login_step::detect_misdirected_login(&session.login_watch),
                credentials_no_profile: true,
            })
        }
        login_step::LoginPollResult::Ready(identity) => identity,
    };

    if let Some(pre) = &session.pre_existing_identity {
        let mismatch = pre.organization_uuid != identity.organization_uuid
            || !pre.email_address.eq_ignore_ascii_case(&identity.email_address);
        if mismatch {
            return Ok(LoginCheckOutcome::Mismatch {
                existing_email: pre.email_address.clone(),
                new_email: identity.email_address.clone(),
            });
        }
    }

    let accounts_path = paths::accounts_file().map_err(|e| e.to_string())?;
    let registered = accounts_store::load(&accounts_path);
    if let Some(dup) = accounts_store::find_duplicate(
        &registered,
        &identity.organization_uuid,
        &identity.email_address,
        Some(session.config_dir.as_path()),
    ) {
        return Ok(LoginCheckOutcome::Duplicate { existing_label: dup.label.clone() });
    }

    session.verified_identity = Some(identity.clone());
    Ok(LoginCheckOutcome::Ready { identity })
}

/// Optional step: grab the web `sessionKey` cookie via the existing CDP
/// browser flow (own chrome profile dir per account).
///
/// Two modes (ai_todo 167):
/// - CLI identity already `Ready`: cross-check the cookie's org list against
///   the CLI identity's `organizationUuid` (unchanged behavior). Returns
///   `None`.
/// - No CLI identity but the profile dir sits in `CredentialsNoProfile`
///   (valid `.credentials.json`, the CLI never wrote `oauthAccount` - it only
///   does so during the live `/login` handshake): derive the identity from
///   the cookie itself via `GET /api/account` (email + chat-capable org),
///   run the same dedup check `add_account_check_login` would, and return
///   the derived identity so the wizard can finish without the CLI's block.
#[tauri::command]
pub async fn add_account_capture_cookie(
    session_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<OauthAccountInfo>, String> {
    let (chrome_profile_dir, cli_org_uuid) = {
        let sessions = state.account_wizard_sessions.lock().unwrap();
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| "wizard session not found or already finished".to_string())?;
        let cli_org_uuid = match &session.verified_identity {
            Some(identity) => Some(identity.organization_uuid.clone()),
            // The cookie-identity fallback is only for the credentials-
            // without-profile state; a dir with no valid credentials at all
            // still has to finish /login first.
            None => match login_step::poll_login(&session.config_dir) {
                login_step::LoginPollResult::CredentialsNoProfile => None,
                _ => return Err(
                    "call add_account_check_login until Ready before capturing the cookie"
                        .to_string(),
                ),
            },
        };
        (session.chrome_profile_dir.clone(), cli_org_uuid)
    };

    let session_key = crate::auth::login_flow::run_for_account(app, chrome_profile_dir)
        .await
        .map_err(|e| e.to_string())?;

    let derived_identity = match cli_org_uuid {
        // Cross-check mode: the CLI identity stays authoritative.
        Some(org_uuid) => {
            let orgs = crate::scraping::client::fetch_org_list("https://claude.ai", &session_key)
                .await
                .map_err(|e| e.to_string())?;
            if !orgs.iter().any(|o| o.uuid == org_uuid) {
                return Err(
                    "the browser login belongs to a different account than the CLI login - log both into the same account"
                        .to_string(),
                );
            }
            None
        }
        // Fallback mode: the cookie IS the identity source.
        None => {
            let account =
                crate::scraping::client::fetch_web_account("https://claude.ai", &session_key)
                    .await
                    .map_err(|e| e.to_string())?;
            let org = account
                .chat_org()
                .ok_or_else(|| "the browser account has no claude.ai organization".to_string())?;
            let identity = OauthAccountInfo {
                email_address: account.email_address.clone(),
                organization_uuid: org.uuid.clone(),
                organization_name: org.name.clone(),
                organization_type: org.subscription_tier(),
                profile_fetched_at: None,
            };

            let accounts_path = paths::accounts_file().map_err(|e| e.to_string())?;
            let registered = accounts_store::load(&accounts_path);
            let exclude = {
                let sessions = state.account_wizard_sessions.lock().unwrap();
                sessions.get(&session_id).map(|s| s.config_dir.clone())
            };
            if let Some(dup) = accounts_store::find_duplicate(
                &registered,
                &identity.organization_uuid,
                &identity.email_address,
                exclude.as_deref(),
            ) {
                return Err(format!("already added as \"{}\"", dup.label));
            }
            Some(identity)
        }
    };

    let mut sessions = state.account_wizard_sessions.lock().unwrap();
    if let Some(session) = sessions.get_mut(&session_id) {
        session.session_key = Some(session_key);
        if let Some(identity) = &derived_identity {
            session.verified_identity = Some(identity.clone());
        }
    }
    Ok(derived_identity)
}

/// Cancel an in-progress wizard run. Deletes the profile dir ONLY if this
/// wizard run created it fresh (never an adopted pre-existing dir).
#[tauri::command]
pub fn add_account_cancel(session_id: String, state: State<AppState>) -> Result<(), String> {
    let session = state.account_wizard_sessions.lock().unwrap().remove(&session_id);
    if let Some(session) = session {
        if session.created_new_dir {
            profile::delete_profile_dir(&session.config_dir).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Step 3: persist the account. Requires a `Ready` identity from
/// `add_account_check_login`; the web cookie (if captured) is persisted
/// alongside, keyed by the new account id. Also runs the best-effort
/// legacy-history migration (milestone 08): if a legacy `session.txt` is
/// still live and its org list contains this account's `org_uuid`, its usage
/// history + capacity re-key to it and the legacy cookie retires. Async
/// (unlike the other wizard steps) purely so that network call can run
/// in-line without blocking the caller on a spawned task; a migration
/// failure never fails account creation.
#[tauri::command]
pub async fn add_account_finalize(
    session_id: String,
    label: String,
    colour: String,
    icon: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Account, String> {
    let session = state
        .account_wizard_sessions
        .lock()
        .unwrap()
        .remove(&session_id)
        .ok_or_else(|| "wizard session not found or already finished".to_string())?;
    let identity = session
        .verified_identity
        .ok_or_else(|| "call add_account_check_login until Ready before finalizing".to_string())?;

    let account = Account {
        id: session.account_id,
        label,
        colour,
        icon,
        config_dir: session.config_dir,
        chrome_profile_dir: session.chrome_profile_dir,
        email: identity.email_address,
        org_uuid: identity.organization_uuid,
        subscription_tier: identity.organization_type.unwrap_or_default(),
        created_at: chrono::Utc::now().to_rfc3339(),
    };

    if let Some(session_key) = session.session_key {
        let session_file = paths::account_session_file(&account.id).map_err(|e| e.to_string())?;
        crate::auth::session::save(&session_file, &session_key).map_err(|e| e.to_string())?;
    }

    let accounts_path = paths::accounts_file().map_err(|e| e.to_string())?;
    let mut accounts = accounts_store::load(&accounts_path);
    accounts.push(account.clone());
    accounts_store::save(&accounts_path, &accounts).map_err(|e| e.to_string())?;

    // Tray only re-renders on "settings-changed"/"usage-updated" - without
    // this, a freshly-added account is invisible in the tray tooltip/menu
    // until the next scheduled poll (up to 600s).
    {
        let snapshot = state.settings.lock().unwrap().clone();
        let _ = app.emit("settings-changed", &snapshot);
    }

    // Best-effort legacy -> this-account migration (milestone 08). The
    // network fetch (`legacy_org_uuids`) runs BEFORE the `state.db` lock is
    // taken below, so the sync `MutexGuard` never has to live across an
    // `.await` point.
    if paths::session_file().map(|p| p.exists()).unwrap_or(false) {
        let legacy_session = paths::session_file().map_err(|e| e.to_string())?;
        match crate::accounts::migration::legacy_org_uuids(&legacy_session).await {
            Ok(org_uuids) => {
                let conn_guard = state.db.lock().unwrap();
                match crate::accounts::migration::apply_migration_if_matching(
                    &account,
                    &org_uuids,
                    conn_guard.conn(),
                ) {
                    Ok(crate::accounts::migration::MigrationOutcome::Migrated { rows_rekeyed, .. }) => {
                        log::info!(
                            "migration: re-keyed {rows_rekeyed} legacy usage row(s) to account {}",
                            account.id
                        );
                    }
                    Ok(crate::accounts::migration::MigrationOutcome::NoMatch) => {}
                    Err(e) => log::warn!("migration: re-key failed for account {}: {e:#}", account.id),
                }
            }
            Err(e) => log::warn!("migration: could not read legacy org list: {e:#}"),
        }
    }

    Ok(account)
}

#[tauri::command]
pub fn list_accounts() -> Result<Vec<Account>, String> {
    let path = paths::accounts_file().map_err(|e| e.to_string())?;
    Ok(accounts_store::load(&path))
}

/// Full teardown: drop the record, delete its profile dir (junctions only -
/// never recurses into `~/.claude` targets, see `accounts::profile`), its
/// chrome profile dir, and its stored cookie. Clears `default_account_id` if
/// it pointed at the removed account.
#[tauri::command]
pub fn remove_account(account_id: String, state: State<AppState>, app: AppHandle) -> Result<(), String> {
    let accounts_path = paths::accounts_file().map_err(|e| e.to_string())?;
    let mut accounts = accounts_store::load(&accounts_path);
    let idx = accounts
        .iter()
        .position(|a| a.id == account_id)
        .ok_or_else(|| format!("no account with id {account_id}"))?;
    let removed = accounts.remove(idx);
    accounts_store::save(&accounts_path, &accounts).map_err(|e| e.to_string())?;

    profile::delete_profile_dir(&removed.config_dir).map_err(|e| e.to_string())?;
    if removed.chrome_profile_dir.exists() {
        let _ = std::fs::remove_dir_all(&removed.chrome_profile_dir);
    }
    let session_file = paths::account_session_file(&removed.id).map_err(|e| e.to_string())?;
    let _ = crate::auth::session::clear(&session_file);

    let settings_path = paths::settings_file().map_err(|e| e.to_string())?;
    let snapshot = {
        let mut settings = state.settings.lock().unwrap();
        if settings.default_account_id.as_deref() == Some(account_id.as_str()) {
            settings.default_account_id = None;
            let _ = crate::settings::save(&settings_path, &settings);
        }
        settings.clone()
    };
    // Tray only re-renders on "settings-changed"/"usage-updated" - without
    // this, a removed account would stay visible in the tray tooltip/menu
    // until the next scheduled poll (up to 600s), even though the account
    // list itself changed regardless of whether default_account_id did.
    let _ = app.emit("settings-changed", &snapshot);
    Ok(())
}

/// Per-account "log out": delete the stored cookie only. Keeps the record and
/// profile dir intact (CLI credentials untouched); chats simply stop
/// spawning for it until the cookie is recaptured. Never touches app data.
#[tauri::command]
pub fn logout_account(account_id: String, state: State<AppState>, app: AppHandle) -> Result<(), String> {
    let session_file = paths::account_session_file(&account_id).map_err(|e| e.to_string())?;
    crate::auth::session::clear(&session_file).map_err(|e| e.to_string())?;
    // Tray only re-renders on "settings-changed"/"usage-updated" - without
    // this, the account's now-missing cookie (chats stop spawning for it)
    // would be invisible in the tray until the next scheduled poll (up to
    // 600s). No settings actually changed; re-emitting the current snapshot
    // is just how the tray's existing listener is wired to trigger a rebuild.
    let snapshot = state.settings.lock().unwrap().clone();
    let _ = app.emit("settings-changed", &snapshot);
    Ok(())
}

#[tauri::command]
pub async fn set_default_account(
    account_id: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    if let Some(id) = &account_id {
        let accounts_path = paths::accounts_file().map_err(|e| e.to_string())?;
        let accounts = accounts_store::load(&accounts_path);
        if !accounts.iter().any(|a| &a.id == id) {
            return Err(format!("no account with id {id}"));
        }
    }
    let settings_path = paths::settings_file().map_err(|e| e.to_string())?;
    let snapshot = {
        let mut settings = state.settings.lock().unwrap();
        settings.default_account_id = account_id;
        settings.clone()
    };
    crate::settings::save(&settings_path, &snapshot).map_err(|e| e.to_string())?;
    // Keep the daemon's cached default_account_id from going stale for the
    // lifetime of an already-connected session - see push_settings_to_daemon.
    crate::daemon_link::push_settings_to_daemon(&state, &snapshot).await;
    let _ = app.emit("settings-changed", &snapshot);
    Ok(())
}

/// The terminal's observed identity (`~/.claude.json`, HOME dir, not inside
/// `~/.claude`). Read-only - the terminal is never an app account.
#[tauri::command]
pub fn get_terminal_identity() -> Option<OauthAccountInfo> {
    let home = dirs::home_dir()?;
    crate::accounts::terminal_identity(&home)
}

/// The Settings > Accounts identity surface (multi-account milestone 07):
/// the profile dir's LIVE `oauthAccount` (may differ from the registry
/// record if someone ran `/login` again since onboarding), the CLI token's
/// expiry, whether a web cookie is currently saved, and a drift flag/message
/// reusing `accounts::drift`'s comparison. All reads, never writes.
#[derive(Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct AccountIdentity {
    pub oauth_account: Option<OauthAccountInfo>,
    pub token_expires_at: Option<i64>,
    pub has_cookie: bool,
    pub drift: bool,
    pub drift_message: Option<String>,
}

#[tauri::command]
pub fn get_account_identity(account_id: String) -> Result<AccountIdentity, String> {
    let accounts_path = paths::accounts_file().map_err(|e| e.to_string())?;
    let accounts = accounts_store::load(&accounts_path);
    let account = accounts
        .iter()
        .find(|a| a.id == account_id)
        .ok_or_else(|| format!("no account with id {account_id}"))?;

    let oauth_account = identity::read_oauth_account(&account.config_dir);
    let token_expires_at = identity::read_token_expiry(&account.config_dir);
    let (is_drift, drift_message) = match drift::compare(account, oauth_account.as_ref()) {
        Ok(()) => (false, None),
        Err(e) => (true, Some(e.to_string())),
    };
    let session_file = paths::account_session_file(&account.id).map_err(|e| e.to_string())?;
    let has_cookie = crate::auth::session::load(&session_file).is_some();

    Ok(AccountIdentity {
        oauth_account,
        token_expires_at,
        has_cookie,
        drift: is_drift,
        drift_message,
    })
}

/// Re-auth: relaunches the same visible `/login` terminal step the wizard
/// uses, targeted at an EXISTING account's `config_dir`. For when the CLI
/// identity has drifted or the token needs a fresh interactive login - the
/// account record, colour, icon, and cookie are untouched.
#[tauri::command]
pub fn reauth_account(account_id: String) -> Result<(), String> {
    let accounts_path = paths::accounts_file().map_err(|e| e.to_string())?;
    let accounts = accounts_store::load(&accounts_path);
    let account = accounts
        .iter()
        .find(|a| a.id == account_id)
        .ok_or_else(|| format!("no account with id {account_id}"))?;
    login_step::spawn_login_terminal(&account.config_dir, &account.label).map_err(|e| e.to_string())
}

/// Per-account cookie (re)capture for accounts that skipped the browser step
/// during onboarding, or whose cookie was cleared by "Log out". Mirrors
/// `add_account_capture_cookie` + the session-key-save half of
/// `add_account_finalize`, but runs directly against an already-registered
/// account instead of an in-flight wizard session.
#[tauri::command]
pub async fn recapture_account_cookie(account_id: String, app: AppHandle) -> Result<(), String> {
    let (chrome_profile_dir, org_uuid) = {
        let accounts_path = paths::accounts_file().map_err(|e| e.to_string())?;
        let accounts = accounts_store::load(&accounts_path);
        let account = accounts
            .iter()
            .find(|a| a.id == account_id)
            .ok_or_else(|| format!("no account with id {account_id}"))?;
        (account.chrome_profile_dir.clone(), account.org_uuid.clone())
    };

    let session_key = crate::auth::login_flow::run_for_account(app, chrome_profile_dir)
        .await
        .map_err(|e| e.to_string())?;

    let orgs = crate::scraping::client::fetch_org_list("https://claude.ai", &session_key)
        .await
        .map_err(|e| e.to_string())?;
    if !orgs.iter().any(|o| o.uuid == org_uuid) {
        return Err(
            "the browser login belongs to a different account than this profile - log into the same account"
                .to_string(),
        );
    }

    let session_file = paths::account_session_file(&account_id).map_err(|e| e.to_string())?;
    crate::auth::session::save(&session_file, &session_key).map_err(|e| e.to_string())
}

// --- One-time "set up your accounts" migration prompt (milestone 08) ---

#[derive(Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct AccountsSetupPromptState {
    pub should_show: bool,
}

/// Whether the dashboard should surface the "set up your accounts" prompt:
/// true only while the registry is still empty AND a legacy `session.txt`
/// exists AND the user hasn't dismissed it. Adding an account (which empties
/// the registry condition) or the migration retiring `session.txt` (which
/// empties the legacy-file condition) both stop the prompt on their own, so
/// there's no separate "seen" flag beyond the explicit dismiss.
#[tauri::command]
pub fn get_accounts_setup_prompt_state(state: State<AppState>) -> Result<AccountsSetupPromptState, String> {
    let accounts_path = paths::accounts_file().map_err(|e| e.to_string())?;
    let registry_empty = accounts_store::load(&accounts_path).is_empty();
    let legacy_session_exists = paths::session_file().map(|p| p.exists()).unwrap_or(false);
    let dismissed = state.settings.lock().unwrap().accounts_setup_prompt_dismissed;
    Ok(AccountsSetupPromptState {
        should_show: crate::accounts::migration::should_show_setup_prompt(
            registry_empty,
            legacy_session_exists,
            dismissed,
        ),
    })
}

/// Persists the user's "not now" / dismiss on the setup prompt. Reusing the
/// prompt's conditions means re-showing it would require BOTH the registry
/// being empty again (it won't) and this flag being unset - so this is
/// effectively permanent for this install, matching `hook_registration_
/// declined`'s pattern (`ipc::projects::skip_hook_registration`).
#[tauri::command]
pub fn dismiss_accounts_setup_prompt(state: State<AppState>, app: AppHandle) -> Result<(), String> {
    let snapshot = {
        let mut s = state.settings.lock().unwrap();
        s.accounts_setup_prompt_dismissed = true;
        s.clone()
    };
    let path = paths::settings_file().map_err(|e| e.to_string())?;
    crate::settings::save(&path, &snapshot).map_err(|e| e.to_string())?;
    let _ = app.emit("settings-changed", &snapshot);
    Ok(())
}
