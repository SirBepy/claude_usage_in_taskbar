# Transcript tool calls: inline chip row + accordion + highlight-on-change

## Goal

In a chat transcript, render each turn's tool activity as ONE inline row of
compact chips (e.g. `Read x4 | Grep x1 | Edited x6 | Ran x9`) instead of the
current vertical stack of full-width `<details>` rows. Clicking a chip reveals
that tool's calls in a section below; only ONE chip is open at a time (clicking
Grep shows greps and HIDES the reads). Highlight the chip that just changed.

## Requirements (from Joe, 2026-06-10)

1. Chips inline on one row per turn (today each `.tool-group` is block-level and
   stacks; they also anchor at first-appearance so interleaved assistant text
   breaks a single row).
2. Accordion expand: click a chip -> show that tool's calls under the row; click
   another -> switch (hide the previous). One open at a time.
3. Edits get their own chip ("Edited"), and clicking it shows which files were
   modified and how many times. (Canonical bucketing already merges Edit/
   MultiEdit/NotebookEdit -> "Edited" and Bash/PowerShell -> "Ran" as of commit
   a80211f via canonicalTool/toolLabel in tool-meta.ts.)
4. Highlight-on-change: when a chip's count increments OR a new chip appears,
   briefly highlight it. Example: row is `Read x4 | Grep x1`; a Bash lands ->
   `Read x4 | Grep x1 | Ran x1` with "Ran x1" highlighted; then a Read ->
   `Read x5 | Grep x1 | Ran x1` with "Read x5" highlighted.
5. Reload bug: grouping currently appears live but Joe saw it "split into its own
   rows" after leaving the chat and coming back. Grouping DOES run on reload
   (bulkLoadEvents -> flushRender -> processTurnCloseQueue -> applyTurnCollapse),
   so the root cause needs a driven repro before fixing. Build a jsdom harness
   that loads a multi-tool turn via loadFromStore/bulkLoadEvents and asserts the
   chips persist (red -> green), do NOT guess-patch.

## Architecture notes

- Grouping lives in `src/shared/chat/turn-collapse.ts` (`groupToolRange`,
  `createToolGroup`, `applyTurnCollapse`). Chips are `<details class="tool-group">`
  with `.tool-group-summary` (already styled as a pill in `src/shared/chat/chat.css`
  ~lines 546-595). They expand a native `<details>` body in-flow.
- To get one inline row + accordion: wrap a turn's chips in a single flex-row
  strip and a shared expansion panel below it, instead of independent `<details>`.
  Clicking a chip fills the panel with that tool's rows (move/clone the grouped
  `.tool-row` elements) and toggles single-open state.
- The grouped rows already carry the tool's target (file/pattern/command) so the
  expansion can reuse them; for the "which files modified" view, the Edited
  expansion lists the file targets + per-file counts (mirror the statusbar
  drill-down `renderToolItems` in session-statusbar.ts if a richer list is wanted).
- Live increment path: `flushRender` calls `groupToolRange(activeTurnStart..)` each
  flush; that's where to flag the just-incremented/added chip for the highlight
  (add a transient CSS class, clear on animationend).
- Per-turn grouping (not cumulative) is correct here; the statusbar tally stays
  the cumulative one.

## Acceptance

- One inline chip row per turn; accordion single-open expand; highlight on
  increment/new; Edited chip lists modified files+counts; reload keeps chips.
- jsdom harness proving reload grouping + a unit test for the accordion/highlight
  DOM behavior. `pnpm tsc --noEmit` clean, `pnpm vitest run` green.
- Visual QA by Joe (the app is his to run; in-app chat can't self-drive).
