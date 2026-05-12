# Split sessions.css into per-component files

## Goal
Break `src/views/sessions/sessions.css` (735 lines) into smaller files aligned with component boundaries.

## Context
`sessions.css` has grown to 735 lines and contains styles for at least three distinct concerns:
- General session pane / sidebar layout (lines 1-374)
- Session statusbar (`session-statusbar.ts` counterpart, lines 375-534)
- Project picker modal (`project-picker.ts` counterpart, lines 535-735)

## Approach
1. Extract lines 375-534 into `src/views/sessions/session-statusbar.css`
2. Extract lines 535-735 into `src/views/sessions/project-picker.css`
3. Import both from wherever `sessions.css` is currently imported (check `sessions.ts` or the HTML entry point)
4. Verify no class names were missed by building and spot-checking the UI

## Acceptance
- `sessions.css` is under 400 lines
- Statusbar and project-picker styles are in their own files
- Build succeeds, UI looks identical
