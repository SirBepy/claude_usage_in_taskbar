# session-statusbar.ts should be split: extract popover management

## Goal
Split `src/views/sessions/session-statusbar.ts` (722 lines) by extracting the four inline popover subsystems into a dedicated module.

## Context
`session-statusbar.ts` mixes two concerns: (1) chip rendering + IPC data refresh, and (2) four fully-inline popover implementations (drain popover, effort popover, model popover, ai-todos popover). The popover blocks each own their own state fields (`drainPopoverEl`, `drainPopoverCleanup`, `effortPopoverOpen`, `modelPopoverOpen`, `aiTodosPopoverOpen`) and DOM-building logic, making the class hard to navigate. Line 722 and growing.

## Approach
Extract popover logic into `src/views/sessions/statusbar-popovers.ts`:
- `DrainPopover`, `EffortPopover`, `ModelPopover`, `AiTodosPopover` as small classes or factory functions, each owning their `open`, `close`, and DOM state.
- `SessionStatusbar` delegates to these, replacing the inline fields and logic with calls to the popover objects.
- Keep chip rendering + data refresh in `session-statusbar.ts`.

## Acceptance
- `session-statusbar.ts` drops below 450 lines.
- `statusbar-popovers.ts` contains the popover subsystems.
- `pnpm tsc --noEmit` passes (only pre-existing vendor error).
- Manual: open a session, click the drain chip, effort chip, and model chip — popovers still open and function correctly.
