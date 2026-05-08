# Statusbar: history view, pending pane, effort level

## Goal

Three small extensions to the session statusbar shipped in `aa3b68d`:

1. Show statusbar in the **history view** (read-only session replay).
2. Show statusbar in the **pending pane** (new-session before first message sent).
3. Add an **effort/thinking level** field (budget token count mapped to Low/Med/High/Max label).

## Context

Current gaps identified in the 2026-05-08 statusbar session:

**History view** (`src/views/history/history.ts`): renders ChatEvents from `load_history` IPC but has no statusbar. Model is available from the `session_started` event in the replay; branch/repo from the `cwd` on the `Instance` or `HistoryEntry`. Duration can show the total session length (ended_at - started_at) rather than a live clock.

**Pending pane** (`renderPendingPane` in `sessions.ts` ~line 419): builds the pane before a real session_id exists. Can show branch/repo from `project.path` immediately (git info fetch is async). Model/context/thinking unavailable until the first turn completes.

**Effort level**: Claude Code's `~/.claude/settings.json` stores `thinking.budgetTokens` (integer). Map to display label:
- 0 or unset: no thinking (don't show chip)
- 1-1000: Low
- 1001-5000: Med  
- 5001-10000: High
- 10001+: Max

Add a Rust IPC `get_thinking_effort()` command that reads `~/.claude/settings.json` and returns the label string or null. Surface as a `thinking_effort` field in `SessionMeta` (separate from `hasThinking` which stays as-is). Add `effort` to `ALL_STATUSLINE_FIELDS` list and default fields.

## Approach

**History statusbar (simplest first):**
- In `history.ts`, after the ChatRenderer attaches and replays, read `renderer.getMeta()` to get model.
- Fetch git info via `get_git_info(cwd)`.
- Render a static (non-live-updating) statusbar using `SessionStatusbar` with `startedAt: null` (so duration chip is static, not ticking). Or pass `historyEntry.started_at` for elapsed total.
- Use `session.ended_at` to show total duration instead of live clock.

**Pending pane:**
- In `renderPendingPane`, after setting `pane.innerHTML`, inject a statusbar host.
- Create `SessionStatusbar` with project path as the cwd for git fetch.
- Wire `state.renderer.onMetaUpdate` after renderer is created.
- Destroy statusbar in the same cleanup path.

**Effort level:**
- Add `ipc/misc.rs::get_git_info` pattern for `get_thinking_effort()` reading `~/.claude/settings.json`.
- Extend `TurnUsage` or add to `SessionStarted` (or just return from a standalone IPC call).
- Register in `lib.rs`. Update `ipc.generated.ts`.
- Add `effort` to `SessionMeta` in `chat-renderer.ts`, populate from `get_thinking_effort()` on session start.

## Acceptance

- History view sessions show model chip and branch/repo chip when available.
- Pending pane shows branch/repo immediately on project selection.
- `effort` chip appears when `~/.claude/settings.json` has a non-zero `thinking.budgetTokens`.
- `npx tsc --noEmit` passes (same pre-existing exclusion).
- Existing statusbar on live sessions unaffected.
