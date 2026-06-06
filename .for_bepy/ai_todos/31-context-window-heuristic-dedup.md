---
id: 31
slug: context-window-heuristic-dedup
title: Collapse the 3 copies of the context-window heuristic once the daemon is proven
status: pending
---

## Goal
After the daemon-owned context_status endpoint is confirmed working live (ai_todo 30 / its BEPY_TODO), reduce the opus-window heuristic from THREE implementations down toward one source of truth.

## Context
The "single source of truth" goal (ai_todo 30) is partially undercut: the `claude-3*opus->200K, *opus->1M, else 200K` window heuristic now exists in THREE places:
- src-tauri/src/context_status.rs (`model_window` / `is_claude_3_opus`) - the PRIMARY/daemon source.
- src/views/sessions/session-statusbar-helpers.ts (`modelContextWindow`) - kept ONLY as a transition/offline fallback for the chip when the IPC returns null.
- ~/.claude/skills/context-left/context-left.mjs (`windowFor`) - the skill's self-compute fallback for non-daemon instances (this one is a legitimately necessary fallback, since a terminal claude with no app running still needs an answer).

The frontend `modelContextWindow` fallback is the removable one: once the relaunched app reliably serves context_status, the chip never needs the local calc. The skill's mjs fallback is genuinely needed (standalone instances) so it stays.

## Approach
- Once the BEPY_TODO confirms the chip reads the daemon value correctly post-relaunch, delete (or hard-deprecate) the `modelContextWindow` fallback branch in session-statusbar.ts + remove `modelContextWindow` from session-statusbar-helpers.ts if it has no other callers (grep first).
- Leave the skill's mjs `windowFor` as the documented standalone fallback.
- Net: 3 copies -> 2 (daemon primary + skill standalone fallback), with the frontend no longer duplicating the logic.

## Acceptance
- The chip has no independent window heuristic; it renders only the daemon value (no fallback calc) OR shows a clear "context unavailable" when the daemon command is missing.
- `modelContextWindow` removed if unused (grep confirms 0 other callers), else left with a comment explaining the remaining caller.
- `pnpm tsc --noEmit` clean, vitest green.
