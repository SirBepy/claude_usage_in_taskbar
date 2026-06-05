---
id: 30
slug: context-left-v2-daemon
title: Context-left v2 - daemon-owned source of truth + auto-wrap-up
status: pending
---

## What

v1 shipped as a self-contained global skill `/context-left` (`~/.claude/skills/context-left/`, NOT in this repo): reads `$CLAUDE_CODE_SESSION_ID` -> own transcript -> remaining = window - occupancy. Works for any claude instance, no daemon.

v2 moves the math into the app as the single source of truth and adds the auto-wrap-up loop:

1. Rust `context_status(session_id) -> {model, window, occupancy, remaining, pct}` in the daemon, reusing the existing occupancy formula. Point the frontend statusbar chip at it too so UI + skill + daemon all agree (kills the duplicated `modelContextWindow` in session-statusbar-helpers.ts).
2. Expose via ONE mechanism (prefer the hooks-server endpoint over a per-session file - no staleness/churn). The skill prefers the endpoint, self-computes as fallback for non-daemon instances.
3. End-of-iteration auto-check: at the end of each turn, if remaining context drops below a threshold (Joe floated ~50%), surface a "consider wrapping up / closing this chat" nudge. (This was explicitly deferred from v1 - the "close hook thing for later".)

## Notes

- THE reliability bug to fix here: the window denominator is currently a naive guess (`opus -> 1M, else 200K` at session-statusbar-helpers.ts:39-45). Opus 4.x runs at EITHER 200K or 1M and the transcript model field (`claude-opus-4-8`) does not say which, so a 200K-Opus user is told 5x too much. v1 mitigates with "if occupancy > 200K it must be >= 1M" + always printing the assumption, but that only disambiguates AFTER 200K is exceeded. v2 should find a definitive variant signal if one exists (check CC env beyond CLAUDE_CODE_SESSION_ID, the SSE stream on CLAUDE_CODE_SSE_PORT, or the system-init line) before falling back to the heuristic.
- occupancy = latest turn `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` (correct, mirror it exactly; never sum all turns).
- Session identity for the endpoint: the skill can pass `$CLAUDE_CODE_SESSION_ID`; the daemon already registers every session by id via the global SessionStart hook.
- Auto-wrap-up belongs in the app/daemon (a per-turn tick), not the skill - the skill has no "end of iteration" event.
