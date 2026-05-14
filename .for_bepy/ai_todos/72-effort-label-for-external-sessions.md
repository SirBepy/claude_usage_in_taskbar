# Show effort label for external/read-only sessions

## Goal

The `effort` chip in the Sessions view statusbar is blank for externally-started sessions (sessions not spawned by this app). Show a best-effort effort label so users can see it across all session types.

## Context

`session-statusbar.ts` renders the effort chip only when `this.effort` is truthy. For interactive sessions the app spawned, effort is set at spawn time from the model-effort modal. For external sessions (`sess.kind === "external"`) the registry always initializes `effort: String::new()`, so the chip is invisible.

The `has_thinking` chip (brain icon) is now fixed for JSONL-replayed sessions (commit `32cb517`), but the effort label (showing "high"/"medium"/etc.) remains blank.

## Approach

Two possible levels:

**Level 1 - global-settings fallback (simple):** When an external session's `effort` is empty, read `effortLevel` from `~/.claude/settings.json` (the user's global Claude Code config) and use it as the display value, marked read-only so clicking it doesn't open the effort picker. This is a reasonable approximation since most external sessions use the global default.

**Level 2 - infer from JSONL (accurate but harder):** The JSONL assistant turns don't carry thinking budget directly, but `has_thinking` is now detected from content blocks (commit `32cb517`). Without a budget_tokens field in the conversation JSONL, we can't map to a specific effort tier without parsing the Claude Code `settings.json` `effortLevel` anyway.

Level 1 is probably sufficient. Implementation:

1. In `session-statusbar.ts`, when constructing the statusbar for an external session (`readOnly: true`), if `opts.effort` is empty, attempt `invoke<Record<string, unknown>>("get_settings")` and read `effortLevel`.
2. Display the result with the `readonly` class (no picker on click).

OR: in `active-session.ts` when building `StatusbarOptions`, if `sess.effort` is empty and `sess.kind === "external"`, prefill `effort` from app settings before passing to `SessionStatusbar`.

## Acceptance

- Open an external session (one started in a terminal, not in the app) in the Sessions view.
- The effort chip shows the global effort level (e.g., "high") in the statusbar.
- Clicking the chip does nothing (read-only, no picker opens).
- For app-created sessions, behavior is unchanged.
