# Patch fibo account's persisted subscription_tier to claude_team

**Type:** task

## Goal

fibo's already-added account has `"subscription_tier": ""` persisted in the app's live `accounts.json`, left over from before ai_todo 173's fix. Either patch that one value directly to `"claude_team"`, or confirm Joe re-ran Reauth/recapture on that account (which re-derives the tier through the now-fixed code path and makes this todo moot).

## Context

Fixed in commit `df15f39b` (2026-07-09): `WebAccountOrg::subscription_tier()` in `src-tauri/src/scraping/client.rs` now falls back to `"claude_" + raven_type` for Team/Enterprise orgs that expose their tier via `raven_type` instead of a `claude_*` capabilities string. Confirmed live via fibo's own `/api/account` response: org capabilities are `["raven","chat"]`, `raven_type` is `"team"` - so the correct persisted value is `"claude_team"` (the frontend's existing `KNOWN_TIERS` map already renders that as "Team").

The fix only prevents the bug for future adds/reauths - it does not retroactively correct already-persisted data. This was flagged as an offer ("I can hand-patch that one JSON value... if you'd rather not wait") that Joe didn't respond to before the session moved on.

## Approach

1. Locate the live `accounts.json` (AppData, outside the repo - check the app's settings/storage path helper for the exact location, e.g. via `src-tauri/src/settings/paths.rs` or equivalent).
2. Confirm the fibo account entry still has an empty `subscription_tier` (it may have self-corrected if Joe reauthed since).
3. If still empty: either (a) set it to `"claude_team"` directly in the JSON (simplest, and now known-correct with certainty per the live API check above), or (b) trigger the app's existing Reauth/recapture flow for that account so it re-derives the value through the fixed code path (more "proper" but requires the app running and a live login flow).
4. Verify: reload accounts list in the UI, confirm fibo's account shows "Team" instead of "Unknown plan".

## Acceptance

- fibo's account no longer shows "Unknown plan" anywhere in the UI (account list, overlay, settings).
- No other account's persisted tier value was touched.
