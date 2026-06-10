# Extract the tool-tally STATE out of chat-renderer.ts into its own module

## Goal

`src/shared/chat/chat-renderer.ts` is 577 lines. The tool-tally *state* tracking (counts per tool + per-target details, dedup by tool_use id, building the `ToolTally` that feeds `onToolTally`) is a cohesive ~40-line unit with low coupling. Extract it to a small `ToolTallyState` class so chat-renderer shrinks and the cumulative-tally logic lives in one place. This MIRRORS the just-shipped extraction of the tally UI (chip row + popover) from session-statusbar.ts into session-tally.ts (commit 86d38fe) - the rendering side is already its own module; this does the same for the state side.

## Context

In chat-renderer.ts the tally subsystem is:
- Fields: `_tools` (~line 62), `_talliedIds` (~line 63).
- Methods: `buildToolTally()` (~211-219), `resetToolTally()` (~221-224), `tallyToolUse(tool, input, id?)` (~227-252).

Its only external deps are `canonicalTool()` / `tallyDetail()` (from tool-meta.ts, already imported) and the `onToolTally` callback (injectable). Re-confirm the exact line ranges by reading the file before editing - chat-renderer.ts has changed recently (the inline tool-chip strip landed in commit ae0e51c).

Note: per-turn grouping in turn-collapse.ts is a SEPARATE concern (the transcript chip strip) and stays put. This todo is only the cumulative statusline tally state.

## Approach

- Create `src/shared/chat/tool-tally-state.ts` exporting `class ToolTallyState` that owns `_tools` + `_talliedIds` and exposes `tallyToolUse(tool, input, id?)`, `resetToolTally()`, and `buildToolTally(): ToolTally`.
- `ChatRenderer` holds a `ToolTallyState` instance and delegates; the `onToolTally` callback fires from the renderer as today (pass the built tally out, or inject the callback into the state class - keep whichever keeps the interface narrow).
- Move the logic VERBATIM (it is pure counting/dedup; no behavior change).

## Acceptance

- chat-renderer.ts drops the ~40 tally-state lines; behavior identical (cumulative `Read x4 · Grep x3 · ...` statusline tally still increments and dedups by id exactly as before).
- `pnpm tsc --noEmit` clean, `pnpm test` green (the session-statusbar-tally + chat-renderer-activity suites still pass unchanged).
