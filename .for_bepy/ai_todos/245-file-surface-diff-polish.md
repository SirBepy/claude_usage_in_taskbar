# File-surface diff polish: syntax-highlight git diffs, side-by-side for session edits

**Type:** task

## Goal

Two deliberate v1 scope cuts in the shared file surface (`src/shared/chat/file-surface.ts`, shipped 2026-07-13): git unified diffs render as plain text with +/- tinting only, and session-edit diffs (renderStackedDiff) are inline-only with the "Side by side" menu item disabled. Lift either or both.

## Context

- The surface renders diffs from two sources: `sessionEdits` (FileEditView[] via renderStackedDiff + enhanceEditDiffs, already shiki-highlighted) and `gitDiff` (raw unified diff parsed by `parseUnifiedDiff`, rendered by inline/split renderers in file-surface.ts).
- Cut rationale at ship time: shiki-highlighting arbitrary diff hunks means per-line language highlighting stitched across +/- fragments; doable (diff-enhancer does something similar for edit windows) but not needed for the approved mockup, which only promised +/- tinting for git diffs.

## Approach

- Git-diff highlighting: reuse the lazy `loadShiki()`; highlight each hunk's lines with the file's language (`langFromPath`) line-by-line (codeToHtml per line is slow - prefer one codeToHtml over the joined hunk body then re-split, the way `diff-enhancer.ts` handles edit windows; read it first and copy its approach).
- Side-by-side for sessionEdits: convert each FileEditView old/new pair into the same row model the split git renderer uses, then re-enable the menu item when the source is sessionEdits.
- Keep the `data-no-search` markers on gutters so the surface search stays clean.

## Acceptance

- PR modal file diff shows syntax colors in both inline and split modes; toggling preserves the active search query (existing behavior).
- Standalone viewer's session-edit diff offers Side by side.
- `pnpm tsc --noEmit` green; no perceptible open-lag on large diffs (shiki work stays lazy/async like today's enhanceEditDiffs).
