# Auto-populate the model list from the live account (query available models)

## Goal

At app boot, discover the models the signed-in account can actually use and refresh the editable model list automatically, instead of relying on the hand-edited `settings.models` list. The "responsive" half of the data-driven-models work Joe asked about.

## Context

Shipped 2026-06-10: the New-session model slider + presets dropdown are now data-driven from `settings.models` (seeded with `["haiku","sonnet","opus"]`), editable in Settings > Session presets (`src/views/settings/subviews/presets/presets.ts`, helper `readModels` in `src/shared/effort-presets.ts`). That's the manual foundation. Joe explicitly deferred the *auto-query* part to a todo because it's the uncertain bit.

The uncertainty: the natural source is Anthropic's `GET /v1/models`, but the chat hub is subscription/OAuth (no API key), and `/v1/models` is normally API-key-authed. The OAuth access token lives at `~/.claude/.credentials.json` (`.claudeAiOauth.accessToken`). There is NO clean `claude` CLI "list models" command. The backend already uses `reqwest` (see `src-tauri/src/news/scraper.rs` OnceCell client pattern, `src-tauri/src/auth/`); custom IPC commands need no capabilities entry (confirmed this session).

## Approach

1. FIRST verify feasibility (this is the gating unknown): hit `GET https://api.anthropic.com/v1/models` with `Authorization: Bearer <accessToken>` + `anthropic-version: 2023-06-01` (+ try the oauth beta header). If the OAuth token is rejected (likely), this whole approach is dead - fall back to keeping the manual list and close this todo as "not feasible without an API key".
2. If it works: add a Rust IPC `fetch_available_models() -> Result<Vec<String>, String>` (reqwest, reads the OAuth token, parses the model ids). Call it once at boot from `src/shared/boot.ts` after settings load; merge/overwrite `settings.models` (preserve the user's manual order where possible, append new). Fall back silently to the existing list on any failure (offline, 401).
3. Cache the result so a boot offline still shows the last-known list.

## Acceptance

- Either: the model list auto-refreshes from the account at boot (verified the token is accepted), OR this todo is closed with a one-line "not feasible: /v1/models rejects the subscription OAuth token, needs an API key."
- Manual editing of the list still works regardless.
- Failure is silent (no broken slider when offline).
