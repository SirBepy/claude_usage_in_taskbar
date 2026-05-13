# Delete dead closing-banner and close-confirm CSS from sessions.css

## Goal
Remove ~134 lines of CSS that is no longer referenced in any TS component.

## Context
`src/views/sessions/sessions.css` lines 375-509 contain styles for two UI elements that were removed from `active-session.ts`:

- `.session-closing-banner` (lines 376-416): banner shown during the `/close /commit` flow.
- `.close-confirm-overlay` / `.close-confirm-dialog` / `.btn-ccd-*` (lines 418-508): modal asking the user whether to commit before closing.

The corresponding TS logic (`showCloseConfirmModal`, the closing banner DOM insertion, `baselineDirtyFiles` capture) was removed from `active-session.ts` in an unstaged batch of changes (visible in `git diff` as of 2026-05-13). Once that batch is committed, these CSS selectors will be unreferenced.

After deletion, `sessions.css` would drop from ~621 to ~487 lines, making further progress toward the original ai_todo 37 goal of <400 lines.

## Approach
1. Confirm that `active-session.ts` no longer contains any reference to `.session-closing-banner`, `.close-confirm-overlay`, `showCloseConfirmModal`, `btn-ccd-*`.
2. Grep the entire `src/` tree for each class name to confirm no other file references them.
3. Delete lines 375-509 from `sessions.css` (the two CSS blocks, including the section comment headers).
4. `npx tsc --noEmit` clean (CSS-only change, but run to be sure).

## Acceptance
- `grep -r "session-closing-banner\|close-confirm\|btn-ccd" src/` returns zero results.
- `sessions.css` is under 490 lines.
- UI loads without visual regressions in the sessions view.
