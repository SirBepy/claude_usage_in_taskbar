# Investigate chat duplicate messages / two-chat split

## Status (2026-05-13)

Hypothesis 3 confirmed and partially fixed in commit `ddcd374`. Root cause for the visible duplicate sidebar row: when we spawn `claude -p`, the SessionStart hook fires inside that process and POSTs to `/hooks/session-start` before our chat IPC parses the stream-json `system init`. Hooks-server registers it as `External` (pid not in `state.channels`), sidebar renders the External row alongside the pending placeholder. Fix: `sidebar.ts` now snapshots pre-existing session_ids when pending starts and filters cwd-matching newcomers until `pending.realId` resolves.

Still open and need Joe to confirm post-fix:

- Hypothesis 1 (button double-bind): static analysis didn't reproduce it; the `sending` re-entry guard already blocks intra-instance double-fire.
- Hypothesis 2 (two Composer instances): static analysis found `destroy()` is always called before `new Composer()`. If `_composerInstanceCount > 1` warning fires in console, this hypothesis is back on the table.
- Hypothesis 4 (rendering-side double): static analysis didn't find a path. Trailing `assistant` line in live `-p` has `stop_reason:null` → `streaming=true`, so the `result` line's `streaming=false` finalize correctly REPLACES the streaming row (verified against `.for_bepy/spike_fixtures/print_resume_turn1.txt`). No fixture exists for `--include-partial-messages` though, so this isn't airtight.

If "same reply rendered twice" persists after `ddcd374`, capture stream-json output of the failing turn (`claude -p --include-partial-messages` on the actual prompt) and add it as a fixture under `src-tauri/tests/fixtures/`, then write a parser+renderer test that replays it and asserts message count.

## Goal

In `/local-session-chat` (and likely any Sessions pane), one user Send results in two assistant replies, sometimes in two separate session entries. Joe also reports seeing the same Claude reply rendered twice in the UI. Find root cause, land a real fix (not just defensive guards).

## Context

Joe's report (2026-05-12 session):
- After clicking Send, "another chat" appears. One answers fast, the other answers shortly after with a slightly different reply.
- Reproduced even on the meta conversation about this very bug: the user prompt about CLAUDE.md → code.claude.com routing showed up in two sessions, each producing its own analysis (one suggested intercepting clicks; the other diagnosed markdown-it linkify treating `.md` as Moldova TLD).
- Joe also sees individual assistant replies rendered twice in the chat pane.

Code review candidates (composer-side, `src/shared/chat/composer.ts`):

1. **Button double-binding**: `render()` rebuilds the composer's innerHTML and reattaches `sendBtn` click handler. `setSessionId` calls `render()`. If `render()` runs twice in quick succession (e.g. pending → real-id swap + readOnly toggle), there's a window where two click handlers exist. `send()` reads textarea synchronously BEFORE clearing — two synchronous handlers both capture the same text and both call `onSend`.
2. **Two Composer instances on same pane**: pending-flow constructs one, view swap to active-session may construct another. Each registers a document-level `_globalKeydown`. Stale composer's `onSend` still wired to old callback closure.
3. **Backend-side double registration**: `chat::runner.rs` spawn + Claude Code's `SessionStart` hook → `/hooks/session-start` registers as "Interactive" instance; sidebar may dedupe incorrectly, surfacing one chat as two entries. Check `sessions/registry.rs::record_interactive_session` + `upsert_interactive`.
4. **Rendering side**: `chat-renderer.ts` may render the same assistant message twice. Could be a synthetic push + the real stream-json `assistant` event for the same content. See `pushSynthetic` for user_message — does anything analogous push for assistant?

Also reported by Joe: AskUserQuestion tool error fires sometimes ("Invalid input: expected record, received null"). May or may not be related — note it here, investigate separately if needed.

## Approach

Phase 1 — instrument:
- In `composer.ts::send`, add `_sending` boolean re-entry guard AND a `console.warn("[composer] double send blocked")` line. Land this regardless; it's defensive.
- Log `[composer] new instance attached sid=<id>` in constructor and `[composer] destroy` in `destroy()` so we can count instances.
- Log `[runner] spawn claude -p sid=<id> turn=<uuid>` in `chat/runner.rs` per spawn.
- Run, reproduce, capture console + Rust stderr.

Phase 2 — fix by signal:
- If guard fires → root-cause double-listener-attachment. Fix `render()` to remove old listeners before rebinding (or use single delegated handler on `root`).
- If two `[composer] new instance` lines appear per pane → fix the lifecycle: pending-flow should reuse the same Composer when swapping placeholder → real id, not construct a new one.
- If two `[runner] spawn` lines per send → trace caller; check ChatState.running and `start_session` vs `send_message` race.
- If only one spawn but two renders → look at chat-renderer's event consumption, particularly `pushSynthetic` ordering vs stream-json `assistant` event.

Phase 3 — verify:
- Send 5 messages in a fresh pending session → exactly 5 assistant replies, single sidebar entry.
- Detach session window → still single reply per send.
- Pending → real-id swap during in-flight first turn → still single reply.

## Acceptance

- Single Send produces exactly one assistant reply, in exactly one sidebar entry.
- Re-entry guard in `send()` never fires under normal usage (would indicate a regression).
- No new `[runner] spawn` logs per Send beyond the expected one.
- Verify with manual repro on Windows; Joe is on Win11.
- Must NOT regress: pending → real-id swap (see `pending-flow.ts:170-200`), session detach window, /close /commit close-flow second-send (`active-session.ts:239`).
