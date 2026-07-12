# Extract a shared anchored-popover helper (schedule-picker + composer-menu)

**Type:** task

## Goal
Factor the body-appended, position:fixed, anchor-repositioned popover scaffolding shared by `schedule-picker.ts` and the new `composer-menu.ts` into one helper.

## Context
`src/shared/chat/composer-menu.ts` (added this session) duplicates the popover lifecycle from `src/shared/chat/schedule-picker.ts`: the `reposition()` (anchor rect -> left/top-or-bottom flip), `onOutside` mousedown-outside close, `onKey` Escape close, and the deferred `setTimeout(() => addEventListener(...))` guard are near-identical. `composer-menu.ts` even reuses the `.schedule-picker-popover` CSS classes.

## Approach
Add e.g. `src/shared/chat/anchored-popover.ts` exporting a helper that, given `{ anchor, el }`, wires reposition + outside-click + Escape and returns a `close()`. Have both `schedule-picker.ts` and `composer-menu.ts` build their inner DOM and delegate positioning/dismissal to it. Keep the shared `.schedule-picker-popover`/`.schedule-picker-rows`/`.schedule-picker-row` styles (or rename to a neutral `.anchored-popover-*`).

## Acceptance
- The reposition/outside-click/Escape logic exists in exactly one place.
- Both the schedule picker and the composer chevron menu still open, reposition (flip above/below), close on outside-click and Escape.
- `pnpm tsc --noEmit` passes.
