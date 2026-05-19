# Smoke-test tool-call preview, changes panel, and live activity bar

## Goal

Verify all 9 success criteria in `docs/superpowers/specs/2026-05-18-tool-preview-and-changes-view-design.md` actually work in a running Tauri build. Vitest passes (30/30) but no UI verification happened in-session.

## Context

Implementation plan executed inline across 9 commits (`facb27b`..`b38cf52`). All new TS modules unit-tested in node env. No live integration test against `cargo tauri dev`. Joe should drive the feature once to confirm rendering, dimming, sheet overlay, and the new live activity bar all behave as specced.

## Approach

1. `cd src-tauri; cargo tauri dev`
2. Start any chat (new or existing). Ask claude to edit a file (e.g. "rename a comment in chat-renderer.ts"). Confirm:
   - The Edit/Write tool_use renders as a collapsible side-by-side window (chevron, basename, +/- badge).
   - Click expands; old text in red column on left, new text in green column on right.
   - The thinking bar above the composer shows "Editing chat-renderer.ts" while the tool is running, then either clears or falls back to the random verb cycle once claude resumes typing.
3. Click the new git-diff icon-btn in the chat header (next to open-terminal-btn). Confirm:
   - Right rail slides in (220px), chat dims behind.
   - File list shows every edit deduped by path, with aggregated +/- counts.
   - Header chip reads "0 of N reviewed".
4. Click a file row. Confirm:
   - Sheet overlay opens to the right of the chat, covering ~85% of pane width.
   - Sheet shows stacked diff of every edit to that file in chronological order.
   - Closing the sheet returns to rail+chat.
5. Check a row's reviewed checkbox. Header chip increments. Row does NOT reorder.
6. Close the rail. Open it again — reviewed state persists within session. Switch to a different chat — reviewed state resets (in-memory only).
7. Open the History view, pick a past session that has Edit calls. Same inline windows + panel should populate.
8. Open an external read-only chat. Panel should still work.

## Acceptance

- All 9 success criteria from the spec verified manually.
- Any visual gaps (overflow, dim layer leaking, sheet z-index, chevron rotation, missing icons) filed as follow-up ai_todos.
- If everything works, delete this file.
