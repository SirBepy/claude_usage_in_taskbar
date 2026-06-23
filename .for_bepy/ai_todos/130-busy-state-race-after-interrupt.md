# Busy state and thinking bar wrong after interrupt + new message

## Goal

After Joe interrupts a running turn and sends a new message, the sidebar should show
"In Progress" and the bottom thinking bar should appear. Currently both stay stuck
showing "Done" even though Claude is actively running.

## Root Cause

Race condition between the pump finalizing the interrupted turn and the new message's
`set_busy(true)` call:

1. Joe interrupts → `cancel_turn` signals Claude
2. Joe sends new message → `send_message` IPC → `set_busy(true)` + `set_awaiting(None)` → `instances_changed` published
3. The pump is still draining the Claude process stdout → eventually reads the `result`
   line for the interrupted turn → calls `set_awaiting(awaiting)` + `set_busy(false)` → **OVERWRITES** step 2
4. Session now has `busy=false` even though Claude is running the new turn

The thinking bar reads `s.busy` from `state.sessions` (via `isCurrentSessionBusy()`), so
it hides. The sidebar `statusPriority` returns "Done" for the same reason.

The `session_start` hook for the NEW turn fires AFTER Claude has processed the stdin
message; if the pump's `set_busy(false)` lands between the two, the final state is
wrong. The race is non-deterministic but consistently reproducible by interrupting and
immediately sending the next message.

## Proposed Fix

**Option A (preferred): generation counter in daemon registry**

Add a `turn_gen: u64` field to `Instance` in the registry. Increment it whenever
`set_busy(true)` is called via `send_message` or `session_start`. In the pump, capture
the generation at turn start; at turn end, only call `set_busy(false)` if the current
generation matches (i.e., no new message arrived since this turn started).

**Option B: flag in cancel_turn**

When `cancel_turn` is called, set a `cancel_pending` flag on the session. The pump, on
reading an interrupted result, only sets `set_busy(false)` if `cancel_pending` is still
set (meaning no new `send_message` cleared it). `send_message` clears `cancel_pending`.

Option A is cleaner because it handles the case where the user sends a message without
explicitly pressing cancel (the previous turn just happened to still be draining).

## Related

- ai_todo 85 covers the "Input Needed → Done on click" question-status symptoms which
  also worsen after an interrupt because this race leaves the session in a bad state.
- The "[Request interrupted by user]" user bubble display is fixed in the same commit
  that writes this todo (suppressed via `isResumeContinuationUserMessage` in
  chat-classifiers.ts).

## Affected files

- `src-tauri/src/sessions/registry.rs` — add `turn_gen` field + increment in `set_busy(true)` path
- `src-tauri/src/daemon/methods/lifecycle.rs` — `send_message` and `session_start` handlers call `set_busy(true)`
- `src-tauri/src/daemon/lifecycle.rs` — pump's turn-end: guard `set_busy(false)` on generation match

## Acceptance

- Interrupt a running turn, immediately type and send a new message.
- Sidebar shows "In Progress" for that session; thinking bar appears at the bottom.
- Normal (non-interrupted) turns still transition Done → In Progress → Done correctly.
- `cargo build --manifest-path src-tauri/Cargo.toml` clean.
