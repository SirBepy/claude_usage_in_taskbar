# Add an enforcement guard against ScheduleWakeup misuse outside /loop

**Type:** skill-improvement

## Goal

Stop `ScheduleWakeup` from getting called as a "check back later" fallback for a plain background `Bash`/`Agent` task - a memory already documents this exact mistake, but it recurred anyway, so the fix needs to be an enforcement gap closed, not another reminder.

## Context

This session, while waiting on a background `Bash` e2e-test run (started via `run_in_background`), called `ScheduleWakeup` as a "come back and check the result" fallback. That is a direct repeat of a documented incident: `~/.claude-personal/projects/.../memory/feedback_schedulewakeup_loop_only.md`, which already says (verbatim) "Do not call `ScheduleWakeup` as a generic safety-net fallback for a background `Agent` call... It is scoped to `/loop` dynamic-pacing mode." That memory exists specifically because this happened once before (2026-07-01) and produced a confusing stray synthetic chat bubble for Joe.

The memory alone didn't prevent the recurrence - it's not surfaced/checked at the moment `ScheduleWakeup` is about to be called outside a `/loop` context. Caught and self-corrected (called `ScheduleWakeup({stop: true})` immediately after realizing the mistake) before it fired, but the near-miss shows the memory-only approach isn't reliable.

## Approach

A `PreToolUse` hook on `ScheduleWakeup` (similar in spirit to the existing `gh-account-switch.sh` global hook) that:
- Checks whether the current session is actually inside a `/loop` invocation (some session-state marker would need to exist for this - may need to check what state `/loop` itself sets, if anything, or whether this needs to be inferred from the conversation/skill-invocation stack instead).
- If not in a `/loop` context, blocks the call with a message pointing back at the `feedback_schedulewakeup_loop_only` memory, telling Claude to just wait for the task-notification instead.

Alternative if a reliable "am I in /loop" signal doesn't exist: a lighter-weight guard that blocks `ScheduleWakeup` specifically when there's a `run_in_background: true` Bash/Agent call still pending in the same turn/session (the exact shape of the mistake both times), rather than trying to detect `/loop` positively.

## Acceptance

- Calling `ScheduleWakeup` outside of `/loop` while a background task is pending gets blocked or flagged, not silently allowed through.
- Genuine `/loop` dynamic-pacing wakeups still work unaffected.
