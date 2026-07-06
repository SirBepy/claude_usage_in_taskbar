# True cross-session auto-send for held (queued) messages

## Goal

A message queued (held) in a session while it's busy should auto-send the moment that turn finishes, even if a *different* chat is currently selected/on screen - not just the moment the user switches back to it.

## Context

Fixed in commit `3a23cdf5` (2026-07-01): held-message auto-flush was edge-triggered (only checked once, on the exact busy `true->false` poll transition, and only when the target session was `state.selectedId`). That caused two symptoms: (1) missed edges due to lossy dual channels (`instances-changed` busy flag vs the chat-message-stream-derived `questionSessions` status) could permanently strand a held message, and (2) held messages for a *non-selected* session never auto-flushed at all - they just sat there until the user manually switched back.

The commit fixed (1) fully (level-triggered re-check on every refresh) and partially fixed (2): switching back into a finished-but-not-selected chat now flushes instantly (`active-session.ts` right after `heldMessages.attach()`), so the practical "stuck forever" case is gone. But if the user never switches back, or wants it to send while still viewing a *different* chat, nothing sends it - by design, since `held-messages.ts`'s `HeldAttach.send`/`interrupt` closures are only wired to whichever session is currently mounted in the active pane (see `active-session.ts:479-517`, `pending-pane.ts:170-291`). Held items for a backgrounded session have no send/interrupt closure available to flush them.

Relevant files: `src/shared/chat/held-messages.ts` (the controller, singleton on `state.heldMessages`), `src/views/sessions/sidebar.ts:145-189` (`refreshSessions`, where the level-check lives now), `src/views/sessions/active-session.ts` (mounts the active pane + wires the send closure), `src/views/sessions/pending-pane.ts` (same for a not-yet-started session).

## Approach

`send_message` (Rust IPC command, see `active-session.ts:470`) already takes `{ sessionId, cwd, blocks }` and does NOT depend on the pane being mounted - it's a plain IPC call. So a session-agnostic flush is possible in principle: capture `cwd` per session (already available via `state.sessions`) and give `HeldMessages` a way to flush an arbitrary (non-attached) session's held set via a generic `invoke("send_message", ...)` + `invoke("cancel_turn", ...)`, instead of requiring `HeldAttach.send`/`interrupt` from the mounted pane.

Sketch:
- Add a `flushBackground(sid, cwd)` path to `HeldMessages` that doesn't require `this.attached.sessionId === sid` - builds the bundle from `this.map.get(sid)`, sends via a raw `invoke("send_message", { sessionId: sid, cwd, blocks })`, clears the held set, and fires a UI refresh (sidebar chip/unread) instead of `onChange()` (which assumes the mounted pane).
- Wire this from `sidebar.ts`'s `refreshSessions()` loop: for any live session (not just `state.selectedId`) that is idle and has held items, call the background flush instead of only marking it unread.
- Question-hold semantics still apply (don't flush if `s.awaiting === "question"` for that session) - same gate as today, just evaluated per-session instead of only for the active one.
- Rejected alternative: keep every session's composer/pane mounted in the background so `HeldAttach` closures stay live for all of them - much heavier (would mean N live renderers/composers instead of 1), not worth it just for this.

## Acceptance

- Queue a message in chat A, switch to chat B before A's turn finishes, let A finish while B stays on screen - A's held message sends without switching back to A.
- The existing "switch back to a finished chat with held items -> instant flush" behavior (from `3a23cdf5`) must not regress.
- A genuine end-of-turn question in a backgrounded session must still hold (not auto-send) until answered, same as today.
- No duplicate sends if both the background-flush path and the reselect-flush path could theoretically fire close together (need a lock/idempotency check, e.g. clear `this.map.set(sid, [])` before the async `invoke` the same way `flush()` already does).
