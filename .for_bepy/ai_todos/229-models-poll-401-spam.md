# fetch_available_models hammers api.anthropic.com with 401s

**Type:** task

## Goal

Stop the constant 401 churn: the GUI log shows `fetch_available_models: HTTP status client error (401 Unauthorized) for url (https://api.anthropic.com/v1/models)` pairs every ~10-60s, all afternoon (2026-07-11).

## Context

Spotted while reading `%LOCALAPPDATA%\com.sirbepy.claudeconductor\logs\Claude Conductor.log` during the pipe-EOF investigation. Something polls `/v1/models` (per account? see `src-tauri/src/ipc/models.rs`) and one credential is invalid/expired, so every poll 401s and presumably retries. Related memory: `feedback_auth_vs_network_failures` (a 401/403 should trigger the re-auth path, not silent retry) and `project_subscription_oauth_hits_v1_models` (subscription tokens hit /v1/models with a beta header - a missing header or plain sessionKey there also yields 401).

## Approach

- Find the caller/poll loop of `fetch_available_models` and which account's token it uses; check whether one of the two accounts' credentials went stale.
- On 401/403: back off (cache the failure, stop re-polling), and surface the account's needs-reauth state in the UI instead of looping.
- Verify the request shape matches what subscription OAuth tokens require (beta header) before concluding the token is dead.

## Acceptance

- App log no longer accumulates 401 lines during normal idle use; at most one line per auth-state change.
- A genuinely expired account shows a visible re-auth prompt/state rather than silent retries.
