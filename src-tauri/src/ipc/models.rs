//! Model-listing and availability-probe commands. Extracted from `misc.rs`
//! (ai_todo 101). Both endpoints authenticate with the Claude OAuth token in
//! `~/.claude/.credentials.json` and fail open so a cold/offline boot never
//! breaks the model picker.

/// Fetch the list of model IDs the signed-in account can use via the
/// Anthropic /v1/models endpoint, authenticated with the Claude OAuth token
/// stored in ~/.claude/.credentials.json.
///
/// Returns the raw list of model id strings newest-first as the API delivers
/// them. Curation (latest-per-family) and merge with user settings happen on
/// the frontend. Fails silently on any error (file missing, bad JSON, network
/// error, non-200, parse failure) and returns an empty vec, so a cold boot
/// while offline never breaks the model picker.
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

/// Resolves the credentials file to probe: the default registered account's
/// `.credentials.json` if one is set, else the terminal's `~/.claude`
/// credentials (pre-M02 behavior - kept as the fallback so this read-only
/// probe still works before anyone completes the add-account wizard).
/// multi-account audit: this is a display-only probe, not a chat spawn path,
/// so it degrades gracefully instead of refusing when no account exists yet.
fn credentials_path_for_default_account() -> Option<std::path::PathBuf> {
    if let Ok(account) = crate::accounts::resolve_default_account() {
        return Some(account.config_dir.join(".credentials.json"));
    }
    dirs::home_dir().map(|h| h.join(".claude").join(".credentials.json"))
}

async fn fetch_available_models_inner() -> anyhow::Result<Vec<String>> {
    let creds_path = credentials_path_for_default_account()
        .ok_or_else(|| anyhow::anyhow!("no home dir"))?;
    let raw = std::fs::read_to_string(&creds_path)
        .map_err(|e| anyhow::anyhow!("read credentials: {e}"))?;
    let creds: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| anyhow::anyhow!("parse credentials: {e}"))?;
    let token = creds
        .get("claudeAiOauth")
        .and_then(|o| o.get("accessToken"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("no claudeAiOauth.accessToken in credentials"))?
        .to_string();

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()?;
    let resp = client
        .get("https://api.anthropic.com/v1/models")
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await?
        .error_for_status()?;
    let body: serde_json::Value = resp.json().await?;
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

/// Read the Claude OAuth access token from the default account's (or, absent
/// one, the terminal's) `.credentials.json`.
fn read_claude_oauth_token() -> anyhow::Result<String> {
    let creds_path = credentials_path_for_default_account()
        .ok_or_else(|| anyhow::anyhow!("no home dir"))?;
    let raw = std::fs::read_to_string(&creds_path)
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

/// Probe whether each given model id is actually usable by the signed-in
/// account.
///
/// The /v1/models listing is NOT a reliable availability signal: it keeps
/// listing models (e.g. Fable 5) even after Anthropic disables them. The free
/// /v1/messages/count_tokens endpoint, by contrast, returns 404
/// not_found_error for a disabled model, so we use it as a zero-cost probe — it
/// only counts tokens, it never generates, so it is never billed.
///
/// Returns a JSON array of `{ id, available, message }`. `message` carries the
/// API's explanation when a model is unavailable (e.g. "Claude Fable 5 is not
/// available. Please use Opus 4.8."), null otherwise. Any error on our side (no
/// credentials, network failure) is treated as available=true so a transient
/// failure never wrongly blocks the picker.
#[tauri::command]
pub async fn probe_models_availability(models: Vec<String>) -> serde_json::Value {
    let all_available = |models: Vec<String>| {
        serde_json::Value::Array(
            models
                .into_iter()
                .map(|id| serde_json::json!({ "id": id, "available": true, "message": null }))
                .collect(),
        )
    };

    let token = match read_claude_oauth_token() {
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
        async move {
            let (available, message) = probe_one_model(&client, &token, &id).await;
            serde_json::json!({ "id": id, "available": available, "message": message })
        }
    });
    serde_json::Value::Array(futures_util::future::join_all(probes).await)
}

/// Single count_tokens probe. Returns (available, optional API message). On any
/// transport error we fail open (available=true) so we never block on a blip.
///
/// Only a 404 not_found_error is treated as "Anthropic disabled this model" —
/// that's the documented signal (see module doc comment above). Any other
/// non-success status (401/403 from a stale OAuth access token — e.g. after
/// the PC sleeps for longer than the token's TTL, since this app never
/// refreshes `.credentials.json` itself; 429 rate limit; 5xx) is OUR side
/// misbehaving, not the model being unavailable, so it also fails open. Before
/// this distinction, a post-sleep 401 got misread as "every model disabled"
/// and stayed that way until an app restart happened to coincide with the
/// `claude` CLI refreshing the token elsewhere — restarting the app never
/// refreshed the token itself, so the dialog just kept re-probing into the
/// same false negative every time it was opened.
async fn probe_one_model(
    client: &reqwest::Client,
    token: &str,
    model: &str,
) -> (bool, Option<String>) {
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
        Err(_) => return (true, None),
    };
    if resp.status().is_success() {
        return (true, None);
    }
    if resp.status() != reqwest::StatusCode::NOT_FOUND {
        return (true, None);
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
    (false, message)
}
