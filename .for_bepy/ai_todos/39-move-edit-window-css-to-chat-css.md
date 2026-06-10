# Move edit-window base styles from sessions.css to chat.css

## Goal

Edit windows render unstyled in the history window: their base rules (`.edit-window*`, sessions.css ~770-830) live in `src/views/sessions/sessions.css`, but the history view imports only `src/shared/chat/chat.css`.

## Context

Found during the 2026-06-10 unified-diff work (commit d10f3ce). The new `.diff-*` rules were deliberately placed in chat.css for exactly this reason; the pre-existing `.edit-window` block (window chrome, summary row, hunk grid, `.diff-add/.diff-del` badge colors and their light-mode overrides) was left in sessions.css to keep that commit scoped. Until moved, history-window edit windows get raw `<details>` styling with no card, grid, or badge colors.

## Approach

Cut the whole edit-window section (from the `/* ── Edit window` comment through `.edit-window-empty`, including the `.diff-add`/`.diff-del` rules and their `[data-theme="light"]`/`[data-mode="light"]` overrides) out of sessions.css and paste it into chat.css next to the existing `.diff-*` unified-diff section. Pure move, no rule edits. Run `npx tsc --noEmit` + `npm test` (CSS untouched by both, but it is the project floor) and eyeball one chat + one history transcript with edits.

## Acceptance

- `grep -n "edit-window" src/views/sessions/sessions.css` returns nothing.
- Edit windows in the Sessions chat pane look unchanged.
- Opening a history transcript containing file edits shows properly styled edit windows (card, collapsible summary, diff badges).
