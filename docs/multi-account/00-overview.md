# Multi-account (Claude Conductor) - implementation plan: overview

This is the anchor doc for a full multi-account feature. Milestone docs `01`..`08` in this
folder expand each phase. A future session picks this up via `/pickup` and orchestrates the
build (see the `/next-ai-prompt` handoff produced at the end of planning).

Visual spec: `.for_bepy/multi-account-mockup.html` (open it). Every screen below is mocked there.

## What we're building

Let the app drive more than one Claude account (e.g. Personal, Work, Fibo). Each account is
isolated for chat + usage, chats route to the right account per project, and the whole thing is
built so the wrong account never touches the wrong work. Along the way the Statistics screen is
absorbed into a customizable dashboard, and the tray gains a floating multi-account overlay.

The real value is not "add a second login", it is **routing + isolation + a glanceable
which-account signal**. Adding the login is the easy part.

## Locked decisions (do not re-litigate)

- **Credential primitive:** per-account `CLAUDE_CODE_OAUTH_TOKEN` (long-lived, from `claude
  setup-token`), injected as an env var per spawned `claude` process. It overrides
  `~/.claude/.credentials.json` and bills to that account's subscription (NOT metered). Env vars
  are per-process, so concurrent sessions can each be a different account from ONE shared
  `~/.claude`. No second config dir. Precedence: `ANTHROPIC_API_KEY` > `CLAUDE_CODE_OAUTH_TOKEN` >
  `.credentials.json`.
- **One shared `~/.claude`.** Because we keep a single config dir, the ~10 hardcoded
  `dirs::home_dir().join(".claude")` readers mostly DO NOT change. Account attribution lives in
  the app's own state (session->account), not the filesystem. This is what shrinks the refactor.
- **Colour / pace config stays global** (one preference applied to every account's numbers + the
  overlay). Not per-account.
- **Tray icon content is user-chosen:** glyph (rings/bars usage), number (% badge), or nothing
  (plain logo). For glyph/number the user picks WHICH account (default = the default account);
  number defaults to the 5h window. The icon stays clickable in all modes (it toggles the overlay).
- **Overlay** is translucent (opacity is a Settings slider) and goes opaque on hover.
- **Number format everywhere:** `usage%/safepace%` (e.g. `42%/55%`), second number dimmed, no
  "safe" word, tooltip on hover. Current number coloured under (green) / over (red) pace. Reset
  time is NOT coloured for being soon.
- **Project binding** lives on the project (Automation subview) as `ProjectConfig.preferred_account_id`,
  and is also editable from the account (a reverse "projects using this account" list). No global
  "project defaults table".
- **New-chat account picker** lives inside the existing model/effort/character modal, collapsed to
  the pre-selected account; "change" reveals chips; changing offers "remember for this project".
- **Add-account** = connect first, then auto-fill name/icon from the returned org info; icon has a
  reroll that skips icons other accounts use. Subscription (Pro/Max/Team) required; API-key
  accounts refused.
- Delete dead/legacy settings while in here: `sync` (dead), and after a no-reader confirm
  `threshold_warn`/`threshold_crit` and `display_mode` (superseded).

## The two authentications (critical, do not conflate)

An "account" here has TWO independent logins:

1. **CLI token** - `CLAUDE_CODE_OAUTH_TOKEN` (subscription), what the chat daemon spawns `claude`
   with. Minted via `claude setup-token`.
2. **Web sessionKey cookie** - what the usage scraper sends to claude.ai's private API
   (`GET /api/organizations` then `/organizations/{id}/usage`). Captured via the existing
   CDP browser login flow.

Usage CANNOT be fetched with the CLI token (different auth); it needs the cookie. So "add account"
is two grants, ideally in one browser trip. Both are one-time per account.

## Account model

`Account { id, label, colour, icon, subscription_tier, oauth_token_ref, session_key_ref,
org_uuid, email, created_at }`. Tokens/cookies stored securely (OS credential store / encrypted
app-data), never in plaintext settings, never committed. Colour + icon are the identity carried
through every screen (the glanceable "which account").

## Architecture by subsystem (where each phase lands)

- **Identity/creds (01):** new accounts registry (typed Rust, in app-data). `auth::session` (single
  sessionKey file) -> per-account store. Add-account orchestrates `setup-token` + the CDP cookie
  grab, reads org name/email back (widen `scraping::client::OrgListEntry`, which today keeps only
  `uuid`).
- **Chat routing (02):** inject `.env("CLAUDE_CODE_OAUTH_TOKEN", token)` at the two spawn sites
  (`daemon/lifecycle.rs:~111`, `channels/spawn.rs`). Thread `account_id` through
  `StartSessionParams` + the session registry. Re-run `check_metered_billing` against the injected
  env. Audit the ~10 `~/.claude` readers (expect: no change needed with one shared dir).
- **Usage (03):** poll loop iterates accounts (one sessionKey each). `UsageSnapshot` gains an
  account id; `AppState.current_usage` and `auth_state` become per-account maps; `usage_snapshots`
  table + capacity model gain an account column.
- **Binding (04):** `ProjectConfig.preferred_account_id` (mirror how `automation` sits there;
  carry-forward in `dedupe_projects_by_path_key`). Automation-subview row + reverse account view +
  the modal picker + `defaultAccountId`.
- **Dashboard (05):** account-selector cards drive account-scoped widgets; global widgets ignore
  selection. Widget registry {id, render, scope: global|account, dataDeps} replaces the closed
  `pinnedCards` enum. Delete the Statistics view; its widgets become dashboard-addable.
- **Tray + overlay (06):** evolve `defaultDisplay`/`iconStyle` into glyph/number/nothing + which-
  account; new floating overlay component (all accounts, 5h+7d, safe pace, opacity + hover);
  `render_tray_now` + `IconSettings`/`TooltipSettings` go per-account.
- **Settings (07):** removals; extend `colorApplyTo` with `overlay`; account-management UI;
  overlay opacity. NOTE the pace/colour logic exists TWICE and is hand-synced:
  `src/shared/formatters.ts` (dashboard/webview) and `src-tauri/src/tray/threshold.rs` (tray). Any
  colour/pace change touches both.
- **Notifications + polish (08):** `notifications.thresholdCrossed` template gains an account
  token; tests (daemon e2e + WebdriverIO); one-time migration of the existing single account into
  the registry; README sync.

## Settings: remove / change / new (from the settings study)

- **Remove:** `sync` (+subfields, dead); `threshold_warn`/`threshold_crit` (Rust, legacy);
  `display_mode` (Rust, superseded by `extra.iconStyle`); `pinnedCards` in its stats-card-id form.
- **Change (single -> per-account):** `AppState.current_usage`, `auth::session`,
  `AppState.auth_state`, tray render path, `notifications.thresholdCrossed` context, single Log Out
  -> per-account manage, `colorApplyTo` gains `overlay`.
- **Keep global:** `colorMode`, `paceBand` (default 10), `paceColors`, `colorThresholds`.
- **New:** accounts registry; `defaultAccountId`; `ProjectConfig.preferred_account_id`; dashboard
  widget layout + per-widget scope; `overlayOpacity` + overlay enable/behaviour; tray content mode
  (glyph/number/nothing) + tray account.

## Cross-cutting risks

- The pace/colour logic is duplicated (formatters.ts + threshold.rs), hand-synced. Every colour
  touch is two edits. Consider a shared source later, do not silently drift.
- Single -> per-account state (`current_usage`, `auth_state`, sessionKey file) is the load-bearing
  Rust change; everything downstream depends on it.
- Migration: the existing single logged-in account must become account #1 in the registry with no
  data loss (its usage history, sessionKey, default status).
- New pure-frontend settings can ride in `Settings.extra` (untyped passthrough); anything Rust
  consumes (accounts, per-account usage, auth) needs typed Rust + `export_types.rs` regen.

## Success criteria

- Two accounts run concurrent chats from one `~/.claude`, no credential clobbering, each billed to
  its own subscription.
- New chat in a bound project auto-selects that account; changing it can be remembered.
- Dashboard shows every account; clicking a card re-scopes the account-tied widgets; safe pace
  shows for 5h + 7d in both the dashboard and the overlay.
- Overlay lists all accounts (5h+7d, safe pace), translucent + opaque on hover.
- Tray icon honours glyph/number/nothing + the chosen account, and still opens the overlay.
- No metered billing possible (subscription-only gate holds per account).
- Statistics screen removed with no lost widgets (migrated to dashboard).

## References

- Design mockup: `.for_bepy/multi-account-mockup.html`
- Related todo: `.for_bepy/ai_todos/138-html-preview-window.md` (previews in a sidepane; brainstorm
  mockups should target it instead of an external browser).
- Temporary manual bridge: `~/.claude/todos/multi-account-cli-wrappers.md` (per-account CLI wrappers).
