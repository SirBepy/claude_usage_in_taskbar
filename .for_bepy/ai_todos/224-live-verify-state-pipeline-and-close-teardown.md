# Live-verify the state-predictability rework and daemon-side /close teardown

**Type:** task

## Goal
After the next app/daemon update is installed and running, verify the 2026-07-11
state fixes (commits a7dbad02, 9ccda9ce) behave correctly live. All are
unit-tested but none has been observed in the real app yet.

## Context
The rework: registry `awaiting` is gen-guarded + persisted and is the ONLY
source for sidebar states (`deriveQuestionSet`); new `<cc-status:working>`
marker renders as In Progress; the daemon pump tears down /close'd sessions
itself (`daemon/close_watch.rs`); `sessions.ts` polls `list_instances` every
15s; when_done won't sleep while a chat reports "working"; `start_session` no
longer pre-sets `busy`. Joe's standing complaint: states flipped randomly
(Input needed / Done / In Progress wrong) and /close'd chats stayed in the
sidebar forever.

## Approach
Checklist, in the updated app:
1. Run a chat turn ending in a question -> row shows Input Needed; send a new
   message, cancel mid-turn, send again -> row must show In Progress, never a
   stale Input Needed.
2. Background a chat, let a scheduled/held message finish a turn there -> its
   row updates without reopening it.
3. Restart the daemon (or reboot) with one chat left on Input Needed -> after
   restart the row still says Input Needed (was: reset to Done).
4. In a chat, dispatch a background subagent so the turn ends with
   `<cc-status:working>` -> row shows In Progress spinner, NOT Waiting.
5. Run /close in a chat and, while the close turn is still streaming, reload
   the app window -> the session must still disappear (daemon-side teardown)
   and must NOT resurrect after an app restart.
6. `/close --dont-close` -> row reverts to normal, chat stays.

## Acceptance
All six checks pass, or failures are written up as new ai_todos with repro
notes. The e2e counterpart (e2e/specs/close-teardown.e2e.js, blocked by
ai_todo 210) can eventually automate 5-6.
