//! Model-listing and availability-probe commands. Extracted from `misc.rs`
//! (ai_todo 101). Both endpoints authenticate with the Claude OAuth token in
//! `~/.claude/.credentials.json`.
//!
//! ## Stale-token recovery (ai_todo 094-followup / 229)
//!
//! After the PC sleeps past the access token's TTL, the app never refreshes
//! `.credentials.json` itself (locked decision - see
//! `docs/multi-account/00-overview.md`: "Claude Code's own token refresh
//! keeps the credentials fresh in place"). Only the `claude` CLI refreshes
//! it, via the refresh token, when invoked. So a 401 here means the ACCESS
//! token is stale, not that the account is logged out - and the fix is to
//! trigger the CLI (which may refresh in place) and re-probe, never to fake
//! availability.
//!
//! `recover_from_401` does that: it shells out to the cheapest CLI
//! invocation that reports true auth state - `claude auth status --json` -
//! under the target account's `CLAUDE_CONFIG_DIR`. That call never starts a
//! session and is never billed, but like every `claude` invocation it
//! refreshes an expired access token via the refresh token before
//! answering. If it reports `loggedIn: true`, the access token is fresh on
//! disk again and we re-read + retry once. If it reports `loggedIn: false`,
//! the refresh token is ALSO dead (or the account was never logged in) and
//! only an interactive re-login fixes it - that state is surfaced to the UI
//! as `authExpired`, never as fail-open "available".
//!
//! `AUTH_CACHE` backs this off per config dir: once a recovery attempt comes
//! back `loggedIn: false`, repeat probes within `REFRESH_BACKOFF` reuse that
//! verdict instead of re-spawning the CLI or re-hitting the Anthropic API,
//! which is what produced the 401 log-spam in ai_todo 229.

use crate::accounts::env::SpawnEnv;
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Minimum time between CLI-driven refresh attempts for the same config dir
/// once one has come back "not logged in". Callers inside this window reuse
/// the cached verdict instead of spawning `claude` or hitting the API again.
const REFRESH_BACKOFF: Duration = Duration::from_secs(60);

/// Per-config-dir cache of the last CLI-driven auth recovery attempt.
struct AuthProbeCache {
    last_attempt: Instant,
    /// `true` once `claude auth status` reported `loggedIn: true` (fresh or
    /// freshly-refreshed token); `false` means the account is genuinely
    /// logged out (refresh token dead too) and needs an interactive re-login.
    logged_in: bool,
}

static AUTH_CACHE: Lazy<Mutex<HashMap<String, AuthProbeCache>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Single-flight guard: concurrent probes (the `join_all` in
/// `probe_models_availability` fires one task per model) that all see a 401
/// at once must not each spawn their own `claude auth status` - only one
/// recovery attempt should ever be in flight for a given moment.
static REFRESH_LOCK: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));

fn cache_key(config_dir: &Path) -> String {
    config_dir.to_string_lossy().into_owned()
}

/// `true` if the cache already knows (within the backoff window) that this
/// config dir needs reauth - lets callers skip the network probe entirely.
fn cached_needs_reauth(config_dir: &Path) -> bool {
    AUTH_CACHE
        .lock()
        .unwrap()
        .get(&cache_key(config_dir))
        .is_some_and(|c| !c.logged_in && c.last_attempt.elapsed() < REFRESH_BACKOFF)
}

/// Fetch the list of model IDs the signed-in account can use via the
/// Anthropic /v1/models endpoint, authenticated with the Claude OAuth token
/// stored in ~/.claude/.credentials.json.
///
/// Returns the raw list of model id strings newest-first as the API delivers
/// them. Curation (latest-per-family) and merge with user settings happen on
/// the frontend. Fails silently on any error (file missing, bad JSON, network
/// error, non-200, parse failure, or a stale token the CLI couldn't refresh)
/// and returns an empty vec, so a cold boot while offline never breaks the
/// model picker.
#[tauri::command]
pub async fn fetch_available_models() -> Vec<String> {
    match fetch_available_models_inner().await {
        Ok(models) => models,
        Err(e) => {
            log::debug!("fetch_available_models: {e}");
            vec![]
        }
    }
}

/// Resolves the default account's config dir to probe: the default
/// registered account's dir if one is set, else the terminal's `~/.claude`
/// dir (pre-M02 behavior - kept as the fallback so this read-only probe
/// still works before anyone completes the add-account wizard). multi-account
/// audit: this is a display-only probe, not a chat spawn path, so it
/// degrades gracefully instead of refusing when no account exists yet.
fn config_dir_for_default_account() -> Option<PathBuf> {
    if let Ok(account) = crate::accounts::resolve_default_account() {
        return Some(account.config_dir);
    }
    dirs::home_dir().map(|h| h.join(".claude"))
}

async fn fetch_available_models_inner() -> anyhow::Result<Vec<String>> {
    let config_dir = config_dir_for_default_account().ok_or_else(|| anyhow::anyhow!("no home dir"))?;
    if cached_needs_reauth(&config_dir) {
        return Err(anyhow::anyhow!("auth expired - reconnect required (backoff)"));
    }
    let token = read_claude_oauth_token_from(&config_dir)?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()?;
    match fetch_models_list(&client, &token).await {
        Ok(ids) => Ok(ids),
        Err(ListFetchError::Unauthorized) => match recover_from_401(&config_dir).await {
            RecoverResult::Refreshed(fresh_token) => {
                fetch_models_list(&client, &fresh_token).await.map_err(|_| {
                    anyhow::anyhow!("auth still failing after CLI refresh")
                })
            }
            RecoverResult::NeedsReauth => Err(anyhow::anyhow!("auth expired - reconnect required")),
        },
        Err(ListFetchError::Other(e)) => Err(e),
    }
}

enum ListFetchError {
    Unauthorized,
    Other(anyhow::Error),
}

async fn fetch_models_list(client: &reqwest::Client, token: &str) -> Result<Vec<String>, ListFetchError> {
    let resp = client
        .get("https://api.anthropic.com/v1/models")
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await
        .map_err(|e| ListFetchError::Other(e.into()))?;
    if matches!(resp.status(), reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN) {
        return Err(ListFetchError::Unauthorized);
    }
    let resp = resp.error_for_status().map_err(|e| ListFetchError::Other(e.into()))?;
    let body: serde_json::Value = resp.json().await.map_err(|e| ListFetchError::Other(e.into()))?;
    let ids = body
        .get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.get("id").and_then(|v| v.as_str()).map(String::from))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(ids)
}

/// Read the Claude OAuth access token from a specific config dir's
/// `.credentials.json`.
fn read_claude_oauth_token_from(config_dir: &Path) -> anyhow::Result<String> {
    let raw = std::fs::read_to_string(config_dir.join(".credentials.json"))
        .map_err(|e| anyhow::anyhow!("read credentials: {e}"))?;
    let creds: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| anyhow::anyhow!("parse credentials: {e}"))?;
    creds
        .get("claudeAiOauth")
        .and_then(|o| o.get("accessToken"))
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| anyhow::anyhow!("no claudeAiOauth.accessToken in credentials"))
}

/// Outcome of a CLI-driven recovery attempt.
enum RecoverResult {
    /// The CLI confirms the account is logged in (token was fresh, or it
    /// just refreshed it) - here's the current access token, safe to retry
    /// the failed request once with it.
    Refreshed(String),
    /// The CLI itself reports the account is NOT logged in (refresh token
    /// dead too, or never logged in). Only an interactive re-login fixes
    /// this - never fail open here.
    NeedsReauth,
}

/// On a 401, ask the `claude` CLI (never us) to refresh `.credentials.json`
/// in place, then report whether it worked. Honors the locked "app never
/// writes credentials" decision (`docs/multi-account/00-overview.md`) - we
/// only trigger the CLI and re-read what it wrote; we never construct or
/// write a token ourselves.
async fn recover_from_401(config_dir: &Path) -> RecoverResult {
    let key = cache_key(config_dir);

    if let Some(cached) = AUTH_CACHE.lock().unwrap().get(&key) {
        if cached.last_attempt.elapsed() < REFRESH_BACKOFF {
            if !cached.logged_in {
                return RecoverResult::NeedsReauth;
            }
            if let Ok(token) = read_claude_oauth_token_from(config_dir) {
                return RecoverResult::Refreshed(token);
            }
        }
    }

    // Single-flight: only one `claude auth status` runs at a time, even if
    // several model probes hit 401 in the same instant.
    let _guard = REFRESH_LOCK.lock().await;

    // Another task may have just finished a recovery attempt while we were
    // waiting on the lock - reuse its verdict instead of running the CLI
    // again.
    if let Some(cached) = AUTH_CACHE.lock().unwrap().get(&key) {
        if cached.last_attempt.elapsed() < REFRESH_BACKOFF {
            if !cached.logged_in {
                return RecoverResult::NeedsReauth;
            }
            if let Ok(token) = read_claude_oauth_token_from(config_dir) {
                return RecoverResult::Refreshed(token);
            }
        }
    }

    let logged_in = run_claude_auth_status(config_dir).await;
    AUTH_CACHE.lock().unwrap().insert(
        key,
        AuthProbeCache { last_attempt: Instant::now(), logged_in },
    );

    if !logged_in {
        return RecoverResult::NeedsReauth;
    }
    match read_claude_oauth_token_from(config_dir) {
        Ok(token) => RecoverResult::Refreshed(token),
        Err(_) => RecoverResult::NeedsReauth,
    }
}

/// Runs `claude auth status --json` under `config_dir`'s `CLAUDE_CONFIG_DIR`
/// and returns whether it reports `loggedIn: true`. Chosen deliberately as
/// the lightest CLI invocation that reports true auth state: it starts no
/// session, is never billed, and exits immediately - but like every `claude`
/// invocation it refreshes an expired access token via the refresh token as
/// part of answering, which is the side effect we actually want.
async fn run_claude_auth_status(config_dir: &Path) -> bool {
    let spawn_env = SpawnEnv::for_account(config_dir);
    let mut cmd = tokio::process::Command::new("claude");
    cmd.arg("auth")
        .arg("status")
        .arg("--json")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    spawn_env.apply_tokio(&mut cmd);
    crate::util::process::hide_console_tokio(&mut cmd);

    let output = match cmd.output().await {
        Ok(o) => o,
        Err(e) => {
            log::debug!("claude auth status: spawn failed: {e}");
            return false;
        }
    };
    let parsed: serde_json::Value = match serde_json::from_slice(&output.stdout) {
        Ok(v) => v,
        Err(e) => {
            log::debug!("claude auth status: parse failed: {e}");
            return false;
        }
    };
    parsed.get("loggedIn").and_then(|v| v.as_bool()).unwrap_or(false)
}

/// Probe whether each given model id is actually usable by the signed-in
/// account.
///
/// The /v1/models listing is NOT a reliable availability signal: it keeps
/// listing models (e.g. Fable 5) even after Anthropic disables them. The free
/// /v1/messages/count_tokens endpoint, by contrast, returns 404
/// not_found_error for a disabled model, so we use it as a zero-cost probe — it
/// only counts tokens, it never generates, so it is never billed.
///
/// Returns a JSON array of `{ id, available, message, authExpired }`.
/// `message` carries the API's explanation when a model is unavailable
/// (e.g. "Claude Fable 5 is not available. Please use Opus 4.8."), null
/// otherwise. `authExpired` is true when a 401 survived a CLI-driven refresh
/// attempt - the account is genuinely logged out, not just "this model is
/// disabled"; the frontend should show a reconnect prompt, not a per-model
/// warning, and `available` is false in that case (never fail-open). Any
/// OTHER error on our side (no credentials configured yet, network failure,
/// 429, 5xx) is still treated as available=true so a transient/offline blip
/// never wrongly blocks the picker.
#[tauri::command]
pub async fn probe_models_availability(models: Vec<String>) -> serde_json::Value {
    let all_available = |models: Vec<String>| {
        serde_json::Value::Array(
            models
                .into_iter()
                .map(|id| serde_json::json!({ "id": id, "available": true, "message": null, "authExpired": false }))
                .collect(),
        )
    };
    let all_needs_reauth = |models: Vec<String>| {
        serde_json::Value::Array(
            models
                .into_iter()
                .map(|id| serde_json::json!({
                    "id": id,
                    "available": false,
                    "message": null,
                    "authExpired": true,
                }))
                .collect(),
        )
    };

    let config_dir = match config_dir_for_default_account() {
        Some(d) => d,
        None => return all_available(models),
    };

    // Backoff fast path (ai_todo 229): a config dir we already know needs
    // reauth doesn't get re-probed until the backoff window elapses.
    if cached_needs_reauth(&config_dir) {
        return all_needs_reauth(models);
    }

    let token = match read_claude_oauth_token_from(&config_dir) {
        Ok(t) => t,
        Err(e) => {
            log::debug!("probe_models_availability: {e}");
            return all_available(models);
        }
    };
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            log::debug!("probe_models_availability: {e}");
            return all_available(models);
        }
    };

    let probes = models.into_iter().map(|id| {
        let client = client.clone();
        let token = token.clone();
        let config_dir = config_dir.clone();
        async move {
            let (available, message, auth_expired) =
                probe_one_model(&client, &config_dir, &token, &id).await;
            serde_json::json!({ "id": id, "available": available, "message": message, "authExpired": auth_expired })
        }
    });
    serde_json::Value::Array(futures_util::future::join_all(probes).await)
}

/// Outcome of a single count_tokens probe attempt.
enum ProbeOutcome {
    Available,
    Disabled(Option<String>),
    Unauthorized,
    /// Network error, 429, 5xx - our side misbehaving, not a real signal
    /// either way; caller fails this open.
    Other,
}

async fn probe_once(client: &reqwest::Client, token: &str, model: &str) -> ProbeOutcome {
    let body = serde_json::json!({
        "model": model,
        "messages": [{ "role": "user", "content": "hi" }],
    });
    let resp = match client
        .post("https://api.anthropic.com/v1/messages/count_tokens")
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return ProbeOutcome::Other,
    };
    if resp.status().is_success() {
        return ProbeOutcome::Available;
    }
    if matches!(resp.status(), reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN) {
        return ProbeOutcome::Unauthorized;
    }
    if resp.status() != reqwest::StatusCode::NOT_FOUND {
        return ProbeOutcome::Other;
    }
    let message = resp
        .json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|v| {
            v.get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .map(String::from)
        });
    ProbeOutcome::Disabled(message)
}

/// Single count_tokens probe, with 401/403 recovery. Returns
/// `(available, optional API message, auth_expired)`.
///
/// Only a 404 not_found_error is treated as "Anthropic disabled this model"
/// (see module doc comment above). A 401/403 first triggers
/// `recover_from_401` (CLI-driven token refresh) and retries once with the
/// fresh token before concluding anything; if the retry ALSO fails auth, or
/// the CLI itself reports the account logged out, this returns
/// `auth_expired=true` with `available=false` - never fail-open on a real
/// auth failure. Any other non-auth error (429, 5xx, network blip) still
/// fails open (`available=true`) so a transient issue never wrongly blocks
/// the picker.
async fn probe_one_model(
    client: &reqwest::Client,
    config_dir: &Path,
    token: &str,
    model: &str,
) -> (bool, Option<String>, bool) {
    match probe_once(client, token, model).await {
        ProbeOutcome::Available => (true, None, false),
        ProbeOutcome::Disabled(message) => (false, message, false),
        ProbeOutcome::Other => (true, None, false),
        ProbeOutcome::Unauthorized => match recover_from_401(config_dir).await {
            RecoverResult::Refreshed(fresh_token) => match probe_once(client, &fresh_token, model).await {
                ProbeOutcome::Available => (true, None, false),
                ProbeOutcome::Disabled(message) => (false, message, false),
                ProbeOutcome::Other => (true, None, false),
                // Fresh token still 401'd - something's genuinely wrong with
                // auth beyond a stale access token; surface reconnect.
                ProbeOutcome::Unauthorized => (false, None, true),
            },
            RecoverResult::NeedsReauth => (false, None, true),
        },
    }
}
