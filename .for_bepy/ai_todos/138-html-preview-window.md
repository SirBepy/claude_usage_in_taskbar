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

- Persisted store (see Decisions log - Joe wants a still-running session's preview to survive app restart). Daemon writes the snapshot timeline to an app-data file and reloads on start; cap the count. (This passes the persistence test: the named cross-restart behavior is "reopen the preview for a chat that's still up".)
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

## Brainstorm / design-mockup consumer (Joe, 2026-07-01)

`/brainstorm` design-mockup previews are a FIRST-CLASS consumer of this window, not just terminal Claude pushing arbitrary HTML. Today that flow writes an HTML file (e.g. `.for_bepy/multi-account-mockup.html`) and `Start-Process`es it into an external browser; it should push to this sidepane instead.
- The in-app chat AI, when it produces a design mockup, pushes it as a `preview` snapshot (slug = mockup name) so iterate-in-place works across rounds (the multi-account brainstorm was many browser reopens that should have been in-place refreshes on one slug).
- CTA: beyond the "Preview pushed" chip, the chat needs an OBVIOUS, persistent open/close toggle for the preview sidepane (Joe wants to dismiss/reopen the design at will, not only auto-open on push). A composer/header control that shows/hides the panel.
- Open: whether the mockup-authoring convention is a dedicated `/brainstorm`-side skill or just the todo-136 injected instruction. Joe undecided ("idk if we should make a skill for it").

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

## Implementation-readiness addendum (gaps resolved, concrete seams)

Confirmed against code so a fresh implementer doesn't block. Each is a DECISION with a lean; the few genuine judgment calls are tagged [decide at build].

### Transport + auth (the big one)
The daemon runs TWO servers:
- **Hook server :27182** - UNAUTHENTICATED, localhost-trusted. Terminal Claude's existing curl relay already posts here (`src-tauri/src/daemon/claude_config.rs:54-78` builds the curl; endpoints in `src-tauri/src/daemon/hooks_server/`, intentionally no token per `hooks_server/mod.rs:1-6`).
- **Remote server :27183** - bearer-token gated, `SAFE_METHODS` allowlist (`src-tauri/src/daemon/remote_server.rs:77-103`), serves the phone.

Decision:
- **Push (write):** new endpoint `POST /hooks/preview` on the **hook server (27182)**, unauthenticated localhost - mirrors the existing relay exactly. Both terminal Claude (curl) and the in-app AI use it. No token plumbing for the curl skill.
- **Read (list/get) for the window + future phone:** add `list_previews` / `get_preview` RPC methods on the remote server AND add both names to `SAFE_METHODS` (the allowlist is the security boundary; new method = explicit entry, `remote_server.rs:77-103`).
- **Security note [SEC]:** an unauthenticated localhost POST means anything running on Joe's machine can inject HTML into the window. For a single-user personal app this matches the existing hook-server trust model and is acceptable. State it; don't add auth.

### Live-update seam
- Global, not per-session. Publish via the daemon-wide `Notifier` (`src-tauri/src/daemon/notifier.rs:18` `publish("preview", json!(...))`) - previews are app-global, not tied to one chat broadcast.
- Lossy under load (`broadcast` capacity drop, caveat at `remote_server.rs:437`), so the window MUST also poll `list_previews` on focus/open, not rely solely on the push (consistent with `project_daemon_notifier_broadcast_lossy`).

### Store scope + semantics
- ONE global preview timeline (not per-session). Snapshot: `{id, slug, title, html, source, session_id?, version, created_at}`.
- `version` (the `v3` in the mockup) = count of pushes for that `slug`. Same slug → version++ and replace the live entry in place; new/absent slug → new entry, becomes live. "Live" = the most-recently-pushed snapshot.
- Cap ~30 (log when older drop). **DECIDED (Joe, 2026-06-26): PERSIST to disk** - on app restart, a still-running session's preview must still be visible, so the store survives restart (not pure in-memory). Persist the snapshot timeline (or at least previews tied to live sessions) to an app-data file; reload on daemon start.

### Rendering details
- `<iframe sandbox="allow-scripts" srcdoc>` fills the canvas with internal scroll. Do NOT try to auto-size to content height (opaque sandboxed origin can't be measured). Device-width control sets the iframe WRAPPER width only.
- HTML input: accept a full document; if a fragment (no `<html>`/`<body>`), wrap in minimal boilerplate before srcdoc. Cap payload (~2MB) → reject + log.
- Inner srcdoc carries its own `<meta>` CSP. **Network policy (Joe, 2026-06-26): do NOT hard-block** - Joe wants the option to allow network (e.g. a preview that fetches data). Lean: allow network, OR ship a default-off toggle that's trivially flippable; do not bake in a hard block. Revisit feel at build.
- Parent CSP: add `frame-src 'self'` to BOTH locations (`src/index.html` meta + `src-tauri/tauri.conf.json`). Verify srcdoc+sandbox interaction at build (may also need `child-src`).
- Empty state: panel/window shows a "No previews yet" placeholder (how to push: `/preview` or ask the chat AI).
- Header actions: open-in-browser = write current html to a temp file + `opener::open` (or open `GET /api/preview/{id}`); copy-HTML = clipboard.

### Frontend mount point
- Right-rail panel = a new flex sibling AFTER `.session-pane` inside `.sessions-layout` (`src/views/sessions/template.ts:66-72`), mounted in `renderSessionsView()` (`src/views/sessions/sessions.ts:121-138`). Shared `renderPreview(root,{mode})` drives both the rail and the pop-out window (label `preview`, opened via new `open_preview_window` IPC mirroring `open_chats_window` in `src-tauri/src/ipc/window.rs`).
- Dock state (docked/popped + width) persisted (real cross-reopen behavior); device-width + auto-refresh defaults can stay in-memory.

### Plumbing the implementer must not forget
- New IPC types (`push_preview`/`list_previews`/`get_preview`, `PreviewSnapshot`, `PreviewMeta`) need an `export_types.rs` entry + regen via `cargo test --test export_types` (use the `CARGO_TARGET_DIR` trick if the dev exe is locked) - `project_ipc_generated_source_of_truth`.
- ts-rs can't parse `skip_serializing_if`/`alias` on the new types - keep them plain (`project_ts_rs_serde_attr_limits`).

### Test plan (project floor expects it)
- Daemon RPC test: push → list → get, and slug-replace vs new-slug semantics (extend the daemon e2e per `feedback_use_existing_test_harness_before_manual`).
- UI regression: WebdriverIO/jsdom test driving render + dock/pop toggle (UI bug → drive the UI, `feedback_ui_bug_regression_drives_ui`).

### Suggested build phasing
1. Store + `POST /hooks/preview` + minimal window view that renders the live snapshot (terminal push → visible). Vertical slice.
2. History rail + slug/version semantics + `list_previews`/`get_preview` + live-update via Notifier (+ focus poll).
3. Dock/pop + persistence + the in-chat "preview pushed" chip.
4. Skills: terminal `/preview` skill + in-app AI convention (rides on todo 136 injection).
5. (Deferred) phone read path + tie the 139 lightbox into this canvas as the shared big-viewer.

## Decisions log
- Persist previews across app restart? **YES** (Joe, 2026-06-26) - a still-running session's preview must survive restart.
- Inner-iframe network blocked by default? **NO hard block** (Joe, 2026-06-26) - keep network available / easily toggled on.
- Everything else in this doc is decided. Plan is handoff-ready.
