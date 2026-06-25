# Turn shows "done" early; messages from concurrent turn swallowed

## Goal

Fix two related symptoms where the sidebar wrongly reports a turn as finished before all
assistant messages are visible, and where a full turn's text output can be silently dropped.

## Context

Joe has observed two failure modes that appear to share a root:

**Symptom A - early "done":** The sidebar shows the session as done (green check), but if Joe
waits a moment, more assistant messages appear. Claude hasn't actually finished yet.

**Symptom B - swallowed turn:** Confirmed in session 2026-06-25. AUQ answer arrived, Claude
internally ran `/rate-it` and produced a full rating response (visible in the LLM's tool
results). But that response text never appeared in the chat UI. Joe then sent a follow-up
message ("what are you waiting for?"), which triggered a NEW turn. Claude interpreted it as
"implement" and committed - Joe never saw the rating.

The two symptoms together suggest either:
1. A `<cc-status:done>` marker appearing in an intermediate tool result or streamed chunk
   (before the actual final message), causing the sidebar and possibly the renderer to treat
   the turn as over prematurely.
2. A race condition: a new user message arriving while a prior turn is still emitting causes
   the prior turn's remaining output to be dropped/not displayed.
3. The AUQ deny-response path (hook → deny+message) closes the turn from the daemon's
   perspective before the LLM has emitted all its text.

Relevant files:
- `src-tauri/src/daemon/lifecycle.rs` - turn lifecycle, `result` line handling
- `src/shared/chat/chat-classifiers.ts` - `STATUS_TOKEN_RE`, status extraction
- `src/views/sessions/active-session.ts:341` - `onStatusUpdate` fires for every historical
  cc-status marker; comment says intermediate markers are handled
- `src/views/sessions/state.ts:64` - `questionSessions` set driven by cc-status
- `src-tauri/src/daemon/hooks_server/permission.rs` - AUQ deny-response path

## Approach

1. **Instrument first:** add logging (or read existing daemon.log) around turn completion
   events - specifically when `cc-status` is parsed vs when the `result` line arrives vs when
   new user input is received. Correlate with a repro.

2. **Check status extraction timing:** in `chat-classifiers.ts`, status is read off streaming
   content. If a partial chunk contains `<cc-status:done>` before the stream ends, the
   sidebar fires early. Verify whether status should only be read from the FINAL message chunk
   (after the `result` line confirms the turn is complete), not from intermediate streaming
   chunks.

3. **Check AUQ path:** when an AUQ deny-response arrives, does the daemon mark the turn as
   complete immediately? If so, any remaining LLM output after the deny is orphaned. The fix
   might be to keep the turn open until the `result` line arrives regardless of AUQ
   resolution.

4. **Race condition guard:** if a new user message arrives while a turn is still streaming,
   the prior turn's buffered-but-unrendered messages should still be flushed to the UI before
   the new turn begins. Check if the renderer discards the queue on new-turn start.

Rejected shortcut: ignoring cc-status until after `result` line globally would break the
"question" amber flag which should light up as soon as Claude asks a question mid-response.
A finer gate (only `done` waits for `result`; `question`/`waiting` fires immediately) may be
the right shape.

## Acceptance

- Start a session, ask something that triggers a long multi-tool response. Send a follow-up
  message immediately while Claude is still streaming. All text from the first turn must
  appear in the chat before the second turn's response begins.
- Reproduce the AUQ race: answer an AUQ question, then immediately type a follow-up before
  Claude's next message appears. The AUQ-answer-turn's response must be visible.
- Sidebar must not show green "done" while assistant messages are still streaming.
- The `onStatusUpdate` early-fire path at `active-session.ts:341` must not regress (it
  currently suppresses intermediate done markers from history replay).
