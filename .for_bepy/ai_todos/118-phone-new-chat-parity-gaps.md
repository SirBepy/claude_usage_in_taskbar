---
id: 118
slug: phone-new-chat-parity-gaps
title: Phone new-chat / display parity gaps (follow-ups after the 2026-06-18 PWA run)
status: open
---

## Context

The 2026-06-18 /autopilot run wired the phone PWA to view characters, view projects, and start a new chat over the remote HTTP transport (shas 755503e, 5d40acf, 5006e03, 10b106d). The core loop works and degrades gracefully, but a few surfaces are still desktop-only. None of these crash the phone (they're caught), they just degrade. Listed smallest-blast-radius first.

## Remaining gaps

1. **Model-availability gating off on phone.** `probe_models_availability` is NOT exposed over RPC (it may shell out to the claude CLI - check before exposing; if it's heavy or process-spawning it should stay off or be cached daemon-side). Effect: the new-chat model picker shows all models as selectable on the phone. Low priority - starting with a default model works.

2. **New-project / open-folder from phone.** The new-chat picker footer buttons call `pick_folder` / `create_folder` (native FS dialogs). These have no phone equivalent and currently throw on tap. Decide: hide these buttons when on the HttpTransport (no `window.__TAURI__`), or wire a phone-appropriate path-entry. Hiding is the honest minimal fix.

3. **Desktop "Chats" sidemenu entry - UX decision.** This run added a `data-view="sessions"` Chats entry to the sidemenu so the PHONE can reach chats. On the DESKTOP main window it navigates the main window to the in-window sessions view (the chats experience is normally a SEPARATE OS window via `open_chats_for_session`). That's additive, not broken, but you may prefer the desktop entry to instead open the separate chats window (or be hidden on desktop). Pick the behavior. NOTE: verify there's no double-subscribe issue if the main-window sessions view AND the separate chats window are both open at once (see memory `project_chat_two_live_sources_ts0`).

## Acceptance

- Phone new-chat picker shows no buttons that throw (gaps 2 handled).
- Desktop "Chats" sidemenu behavior is whatever you decide in gap 3, with no live-source double-subscribe regression.
- `cargo build --manifest-path src-tauri/Cargo.toml` + `pnpm tsc --noEmit` clean.
