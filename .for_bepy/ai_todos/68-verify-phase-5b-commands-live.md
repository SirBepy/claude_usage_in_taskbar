# Manually verify the 5 Phase 5b chat commands (flag on)

## Goal
Phase 5b wired 5 app commands to daemon RPC but only the daemon side + build/unit tests were checked. The actual UI flows were never exercised live. Verify each works against a running daemon with `useDaemon=true`.

## Context
Shipped 2026-05-21 on branch `daemon-phase-5a-chat-cutover` (commits ddee891, cbdc5c5, a0139dc, 51997e9). The commands now forward to daemon RPC: `clear_session` -> mark_session_ended, `open_session_in_terminal` -> externalize_session, `set_session_effort` -> set_session_effort, `register_historical_session` -> register_historical, `takeover_manual` -> takeover. Survive-close + snapshot-on-connect were verified live; these 5 were not.

## Approach
With the daemon running + flag on (settings.json `useDaemon: true`), in the app:
1. Close a chat (X / close-session) -> session disappears from sidebar (mark_ended fired).
2. "Open in terminal" on an Interactive chat -> the sidebar row flips to External (read-only) within a few seconds (externalize fired); a real terminal opens.
3. Change effort on a session -> persists (set_effort fired; check it survives a sidebar refresh).
4. History view -> "Continue this chat" -> the session re-appears as an Interactive entry (register_historical fired) and you can send.
5. Takeover: with an external `claude` running (a terminal CC instance registered via the SessionStart hook showing as External in the sidebar), use the takeover action -> it promotes to Interactive, kills the external process, and you can send a message that resumes that conversation.

## Acceptance
- All 5 behaviors work via the daemon path with no console errors and the sidebar reflects each change.
- Note: these commands forward UNCONDITIONALLY (not flag-gated) by design - the registry is daemon-owned - so they should also behave sanely in Path C mode (flag off) where the session was registered via the SessionStart hook.
