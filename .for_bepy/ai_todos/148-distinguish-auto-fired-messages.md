# Distinguish auto-fired/system continuation messages from real user messages in chat UI

## Goal

When a scheduled continuation (e.g. Claude's own `ScheduleWakeup`, or an autopilot/night-run self-prompt) fires and gets submitted into a session, the chat UI currently renders it as an indistinguishable normal user bubble - identical to something Joe actually typed. Figure out whether this is fixable, and if so, make auto-fired continuation messages visually distinct (or otherwise clearly attributed) from real user messages.

## Context

Observed 2026-07-01: main session scheduled a `ScheduleWakeup` (harness tool, meant for `/loop` dynamic-pacing mode, not a generic "check back later") as a fallback in case a background subagent's completion notification didn't arrive. The notification arrived early and was already handled in the very next turn. ~20 minutes later the scheduled wakeup fired anyway and its literal prompt text got submitted into the session like a normal turn. Joe saw it in the app as a plain user-authored message bubble and was confused about who sent it.

Underlying constraint: the claude session transcript (JSONL) marks both real Joe messages and these auto-fired continuations with the same `role: user` - there is likely no existing structural marker distinguishing "harness/scheduled auto-continuation" from "human typed this." This needs verifying, not assumed.

Related prior art in this codebase for message-embedded/skill-provenance distinction:
- `project_ai_chat_titles`, `project_close_lifecycle_markers` - the app already parses `<cc-*>` markers embedded in assistant messages for other purposes (title, status, close lifecycle).
- Commit `5526d56c FIX: dedup skill-command user bubbles across runner/watcher sources` - the app has prior handling logic for distinguishing/deduping certain synthetic user bubbles (skill-invocation bubbles) from organic ones. Look at how that dedup identifies skill-command bubbles - there may be a reusable signal (e.g. a prefix convention, a sentinel, or metadata already available at the daemon/runner layer) that could extend to scheduled-wakeup-fired turns too.

## Approach

1. Investigate whether the raw JSONL transcript (or the daemon's stream-json event data) carries ANY distinguishing metadata for a harness-auto-fired turn (e.g. a system-generated marker, hook name, or event type) versus a literal user-typed turn. Check how `5526d56c`'s skill-command bubble dedup identifies its bubbles - same mechanism might apply.
2. If no existing signal: determine if it's even possible to add one. Scheduled wakeups are a Claude Code harness feature (not owned by this app's code), so there may be no hook available to tag them at the source. If genuinely unfixable at the data layer, document that finding and close this as "not actionable from app code, mitigate via not misusing ScheduleWakeup outside proper /loop contexts instead."
3. If a signal exists or can be added: render these turns distinctly in the chat UI (e.g., a muted "auto-continuation" label/style instead of the normal user bubble), following the same shared-rendering-path principle as `tool-views.ts` (don't duplicate rendering logic across chip/statusline consumers - see `project_tool_views_shared` memory).

## Acceptance

- Either: a working UI distinction ships for auto-fired continuation messages, verified by manually triggering a `/loop` or scheduled-wakeup-fired turn and confirming it renders differently from a real typed message, OR
- The investigation concludes it's not distinguishable given current data and that conclusion is written back into this todo (or a memory) before closing it - do not silently drop this without a documented reason either way.
- Must not regress the existing skill-command bubble dedup (`5526d56c`) - reuse/extend it rather than adding a parallel detection path.
