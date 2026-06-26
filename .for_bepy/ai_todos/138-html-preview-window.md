---
id: 138
title: In-app HTML preview window (dockable) + push channel + skills
priority: medium
area: full-stack (daemon + frontend + skills)
status: planned (design locked, not built)
---

## What

Our own HTML preview surface inside Claude Companion, so previews render in-app instead of spinning up a localhost server and opening an external browser (the current "browser companion" flow). Both terminal Claude and the in-app chat AI push HTML to one shared daemon channel; a dockable panel renders the live latest with a snapshot-history rail.

Design mockup: `.for_bepy/preview-window-mockup.html` (open it / see `preview-docked.png`, `preview-popped.png` captured 2026-06-26).

## Locked decisions (from Joe, 2026-06-26)

- **Source:** BOTH terminal Claude (via curl to the daemon) and the in-app `claude -p` session push to ONE shared daemon `preview` channel.
- **Form:** DOCKABLE. Default = panel in the Chats window; "pop out" -> its own OS window; "dock back" returns it. One shared render component drives both (per `feedback_prefer_shared_components`).
- **Content model:** LIVE LATEST + SNAPSHOT HISTORY. A push with the same `slug` refreshes the live entry in place (the iterate loop); a new/absent `slug` appends a new snapshot. All snapshots stay in a scrollable history rail.
- **Phone:** Desktop-only for v1, but the channel/store is built phone-ready (daemon-owned, RPC-mirrored like `read_attachment`) so phone parity is a later add, not a rewrite.

## Architecture

### Store + channel (daemon-owned, single source of truth)
The daemon owns preview state so both sources and (later) the phone hit one place. Mirror the existing `read_attachment` / `character_asset_url` pattern: daemon RPC method + desktop IPC proxy.

- In-memory store (no persistence v1 - previews are ephemeral design artifacts; naming the cross-close behavior fails the persistence test, so default to in-memory per the persistence rule). Optional later: persist last-N to disk if Joe wants previews to survive an app restart.
- Snapshot shape: `{ id, slug, title, html, source: "terminal" | "chat", session_id?, created_at }`.
- Cap history (e.g. last 30) to bound memory; `log`/note the cap, never silently drop more.

### Endpoints
- `POST /api/preview` body `{ title, slug?, html, source, session_id? }` -> stores, returns `{ id }`, broadcasts a `preview` event. Curl-friendly for terminal Claude (same transport as the existing hook relay - curl, not the GUI exe).
- `GET  /api/preview/list` -> snapshot metadata (no html) for the rail.
- `GET  /api/preview/{id}` -> full html for the iframe.
- Broadcast channel `preview` (WS / existing notifier) -> window refreshes. NOTE: daemon->app broadcast is lossy under backpressure (`project_daemon_notifier_broadcast_lossy`); the window must also be able to poll `/api/preview/list` on focus, not rely solely on the push.
- Desktop IPC mirror: `push_preview`, `list_previews`, `get_preview` (custom `#[command]`s - authorized by `generate_handler`, no capabilities entry needed per `project_custom_commands_no_capabilities_entry`). The in-app chat AI path can reuse the HTTP endpoint too; pick whichever keeps one code path.

### Rendering (security)
- Render each preview in an `<iframe sandbox="allow-scripts" srcdoc="...">`. **No `allow-same-origin`** -> opaque origin, scripts run but cannot reach the parent DOM, the daemon bearer token, app storage, or IPC. This is the key isolation boundary: AI HTML may contain scripts and may pull in third-party snippets.
- Wrap the srcdoc html with a restrictive inner `<meta>` CSP so an embedded preview can't exfiltrate over the network unexpectedly (allow self/data/inline for look-right rendering; decide network policy - lean: block `connect-src`/external by default, with an explicit "allow network" toggle later if a preview needs it).
- Parent-page CSP: add `frame-src 'self'` to BOTH CSP locations (`src/index.html` meta tag AND `src-tauri/tauri.conf.json`) per `project_csp_two_locations`, or the iframe is blocked.

### Frontend
- New shared component `renderPreview(root, { mode })` (panel | window). Registered as a router view `preview` (per `src/router.ts` + `main.ts` registerView) AND openable as a standalone window `preview` via a new `open_preview_window` IPC mirroring `open_chats_window` (`src-tauri/src/ipc/window.rs`).
- Dock state (docked vs popped, panel width): this IS a real cross-close behavior (panel stays where Joe left it across Chats-window reopen), so persisting it passes the persistence test. Store in chat-config / a small preview-config (daemon sole writer if shared desktop+phone, per `project_auto_accept_persistence`).
- A chat "Preview pushed: <slug>" chip in the conversation (reuses the tool-chip render path in `src/shared/chat/tool-views.ts`); click -> opens/focuses the panel on that snapshot.

### UI layout (see mockup)
- **Header:** monitor-play icon + `<slug> . v<n>`, source badge (terminal=green / chat=accent dot), LIVE pulse when a fresh push just landed, actions: refresh, open-in-browser (escape hatch to the real browser), copy-HTML, pop-out/dock toggle, close.
- **Sub-bar:** device-width segmented control (Desktop / Tablet / Phone - cheap responsive check, just sets iframe wrapper width) + auto-refresh toggle.
- **Body:** left history rail (snapshot cards: title, version, source dot, relative time, LIVE tag on the live one) + checkered canvas hosting the sandboxed iframe.

## Skills (build AFTER the window lands)

- A terminal-Claude skill (e.g. `/preview`) that takes an HTML file or inline HTML and curls it to `POST /api/preview` with a `slug` (so re-running iterates in place). This replaces the "open a localhost server in the browser" companion flow for static mockups. Document the convention so Claude reaches for the window instead of the browser.
- The in-app chat AI path: extend the session-injected instructions (todo 136) to teach the convention - emit a preview push (sentinel or tool) the daemon turns into a snapshot. Same shape as the screenshot-inline convention (todo 132). Relates to `feedback_send_vs_display_split`.

## Relationship to existing todos
- 132 (inline screenshots) - sibling: both are "AI surfaces a visual in the app." Could share the source-badge / chip vocabulary.
- 136 (inject formatting instructions) - the chat-AI push convention rides on this injection mechanism.
- 135 (clickable file refs) - independent but same renderer seam.

## Success criteria
- Terminal Claude curls HTML -> it renders in the in-app panel within ~1s, no external browser.
- Re-push same slug -> live view refreshes in place; new slug -> new history entry; old snapshots reachable from the rail.
- Pop-out moves the same view to its own OS window; dock-back restores the panel; dock state survives a Chats-window close/reopen.
- Sandboxed iframe: a preview script cannot read the parent DOM or the daemon token (verify with a probe preview).
- CSP updated in both locations; no regression to existing chat image rendering.
- (Designed-for, not shipped v1) the same channel can serve the phone PWA later with no store rewrite.

## Open question for build-time (not blocking the plan)
- Inner-iframe network policy: block external `connect-src` by default vs allow. Lean block-by-default + later opt-in toggle.
