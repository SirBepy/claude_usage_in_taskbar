# Auto-populate the model list from the live account (query available models)

## Goal

At app boot, discover the models the signed-in account can actually use and refresh the editable model list automatically, instead of relying on the hand-edited `settings.models` list. The "responsive" half of the data-driven-models work Joe asked about.

## Context

Shipped 2026-06-10: the New-session model slider + presets dropdown are now data-driven from `settings.models` (seeded with `["haiku","sonnet","opus"]`), editable in Settings > Session presets (`src/views/settings/subviews/presets/presets.ts`, helper `readModels` in `src/shared/effort-presets.ts`). That's the manual foundation. Joe explicitly deferred the *auto-query* part to a todo because it's the uncertain bit.

FEASIBILITY: CONFIRMED 2026-06-11 (autopilot). `GET https://api.anthropic.com/v1/models` with `Authorization: Bearer <claudeAiOauth.accessToken>` + `anthropic-version: 2023-06-01` + `anthropic-beta: oauth-2025-04-20` returns **HTTP 200** with the consumer Max-subscription token (scopes: user:file_upload, user:inference, user:mcp_servers, user:profile, user:sessions:claude_code). No API key needed. The earlier "likely rejected" guess was WRONG - it works. The OAuth access token lives at `~/.claude/.credentials.json` (`.claudeAiOauth.accessToken`). The backend already uses `reqwest` (see `src-tauri/src/news/scraper.rs` OnceCell client pattern, `src-tauri/src/auth/`); custom IPC commands need no capabilities entry.

The endpoint returns 11 model ids today (full/dated, NOT clean aliases):
`claude-fable-5, claude-opus-4-8, claude-opus-4-7, claude-sonnet-4-6, claude-opus-4-6, claude-opus-4-5-20251101, claude-haiku-4-5-20251001, claude-sonnet-4-5-20250929, claude-opus-4-1-20250805, claude-opus-4-20250514, claude-sonnet-4-20250514`.

## OPEN DECISION (Joe's call before building - this is now the real gate, not feasibility)

The current `settings.models` is a clean curated alias list (`["haiku","sonnet","opus"]`). `/v1/models` returns 11 full/dated ids including legacy snapshots (opus-4-1, sonnet-4, opus-4-5-dated). Auto-overwriting would dump all 11 dated ids onto the slider and break the clean-alias UX. So decide:
1. CURATION: show all 11, or filter (e.g. drop dated snapshots + legacy <4.6, map to friendly aliases)?
2. OVERWRITE vs MERGE vs SUGGEST: replace the manual list, append-new-only, or just surface "N new models available" without touching the user's list?
3. The models list was JUST made deliberately manual/data-driven (2026-06-10). Confirm auto-query is still wanted before reversing that.

## Approach (once the decision above is made)

1. Add a Rust IPC `fetch_available_models() -> Result<Vec<String>, String>` (reqwest, reads the OAuth token + sends the 3 headers above, parses `data[].id`). Call once at boot from `src/shared/boot.ts` after settings load; apply per the chosen overwrite/merge/suggest policy. Fall back silently to the existing list on any failure (offline, 401, expired token - refresh is NOT handled here).
2. Cache the result so a boot offline still shows the last-known list.

## Acceptance

- The model list reflects the account per the chosen curation+merge policy at boot; manual editing still works.
- Failure is silent (no broken slider when offline).
