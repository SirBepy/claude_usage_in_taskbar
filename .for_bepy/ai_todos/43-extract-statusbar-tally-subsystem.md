# Extract the statusbar tool-tally chip+popover subsystem out of session-statusbar.ts

## Goal

`src/views/sessions/session-statusbar.ts` is 539 lines and mixes several concerns.
The tool-tally subsystem (chip row + per-tool drill-down popover + item rendering)
is a cohesive ~150-line unit that grew this session and now reads as its own
module. Extract it to shrink the statusbar file and isolate the tally UI.

## Context

This session expanded the tally subsystem: per-chip popovers (`openToolPopover`,
`toggleToolPopover`, `closeTallyPopover`, `renderToolItems`), the chip render with
`tallyHiddenTools` filtering, and downward-popover positioning. These live amid
unrelated statusbar concerns (git/meta/counts/context fetching, effort + model
popovers, duration timer). The tally code is self-contained: its only external
inputs are `this.toolTally` (a `ToolTally`) and `this.tallyHiddenTools`, plus the
`toolSummary`/`TALLY_LABELS` helpers and the `invoke`/`openLightbox` side effects.

Pre-existing peers also >400 lines if a broader split is wanted later:
`chat-renderer.ts` (546, tally state `_tools`/`tallyToolUse`/`buildToolTally`
could co-extract) and `composer.ts` (522). Those are lower priority.

## Approach

- Create `src/views/sessions/session-tally.ts` exporting a small controller (e.g.
  `class ToolTallyRow`) that owns: chip HTML build (given tally + hidden list),
  the body-appended popover element, open/close/toggle, item rendering, outside-
  click cleanup, and downward positioning.
- `SessionStatusbar` keeps `toolTally`/`tallyHiddenTools` state and delegates the
  chip-row HTML + click wiring to the controller. Move the `.sb-tally-*` CSS as-is.
- Port the existing `tests/session-statusbar-tally.test.mjs` assertions; they
  should pass unchanged (same DOM classes/behavior).

## Acceptance

- `session-statusbar.ts` drops the ~150 tally lines; behavior identical (chips,
  per-chip popovers, downward open, hide-filter, file/image/text rows).
- `npx tsc --noEmit` clean, `npx vitest run` green (statusbar-tally suite passing).
