# Split sessions.css into per-component files

## Goal
Break `src/views/sessions/sessions.css` (now 942 lines) into smaller files aligned with component boundaries.

## Context
`sessions.css` has grown to 942 lines. Some splits already happened (statusbar, project-picker, model-effort-modal each have their own .css). The remaining content still mixes:
- General session pane / sidebar layout (lines 1-558ish)
- Prompt card / permission-modal styles (`.prompt-card*`, `.prompt-tab*`, `.prompt-q*`, `.prompt-opt*`, lines 559+) - these belong with `permission-modal.ts` not `sessions.ts`

## Approach
1. Extract all `.prompt-card`, `.prompt-tab`, `.prompt-q`, `.prompt-opt`, `#prompt-card-host` rules into `src/views/sessions/permission-modal.css`
2. Import it from `permission-modal.ts` (or from `sessions.ts` - wherever permission-modal styles currently come from)
3. Verify sessions.css drops below 600 lines and the permission/question card still renders correctly

## Acceptance
- `sessions.css` is under 600 lines
- Prompt-card styles are in `permission-modal.css`
- Build succeeds, permission + question modal UI looks identical
