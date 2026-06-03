# Rewrite sidebar exit animation to take exiting rows out of flow (position:absolute)

## Goal
Replace the FLIP-based exit/reorder choreography in `src/views/sessions/sidebar-anim.ts` with one where an exiting row is taken OUT of layout flow (`position:absolute`) the moment it starts sliding out, so the surviving rows reflow up naturally and animate via a single transition. This removes the whole class of timing bugs that come from the current "remove the node at the right moment, then FLIP survivors from stale rects" design.

## Context
The current reconciler couples three mechanisms that must stay in sync, and each has bitten us (session 2026-05-30/31, commits 4eae951 / 56f9e12 / 08bf3fc):
- Exit-node removal is owned by the deferred `applyReorder` (removing earlier reflows siblings and the stale-rect FLIP yanks them back = flash-back).
- The deferred reorder uses a single-flight fixed-deadline scheduler (`pendingApply`/`applyScheduled`/`EXIT_SETTLE_MS`) because a per-reconcile reschedule starved new-row insertion during an `instances-changed` burst.
- Exit suppression (`exitingKeys`) requires unique keys (pending draft is keyed `p:<placeholderId>`).
- `flipNodes` manually inverts + plays survivor motion and only the bottom-most riser casts a shadow.

All of this exists to sequence "exit finishes, THEN survivors move up" without flashing. A `position:absolute` exit sidesteps it: the exiting row leaves flow → survivors reflow immediately → they animate up with a plain CSS transition; the exiting row slides out on its own layer and is removed on `animationend`. No FLIP, no stale rects, no deferral, no starvation.

See memory `project_sidebar_anim_exit_architecture` for the full mechanism notes.

## Approach
- On exit start (`markSessionExiting` + reconcile exit-start): set the row `position:absolute` pinned at its current top/left/width, add `row-exiting` (slide-out), remove on `animationend`.
- Survivors: give the list rows a `transform`/`top` transition so they slide up into the freed space without manual FLIP. Or keep a much simpler FLIP that measures AFTER the exiting row is already out of flow (no deferral needed).
- New-row insertion happens synchronously in the reconcile (no deferral), so a new draft is never delayed/starved.
- Preserve the bottom-most-riser-only shadow behaviour.
- Keep exit suppression / unique keys (still needed so an exiting row isn't re-entered as a new row).

## Acceptance
- `tests/sidebar-anim-close.test.mjs` and `tests/sidebar-draft-render.test.mjs` still pass (extend them; the jsdom harness can't assert pixels but can assert node lifecycle / no-starvation / unique-key behaviour).
- Manual QA (needs Joe's eyes, jsdom has zero rects): close a chat → no flash-back; close then immediately open a new chat → new draft shows instantly; a group sliding up shows one clean shadow under the bottom row.
- The single-flight scheduler, `EXIT_SETTLE_MS` deferral, and manual FLIP invert are gone or substantially simplified.
- `pnpm tsc --noEmit` clean (modulo the pre-existing main.ts:157/163 TS2722).
