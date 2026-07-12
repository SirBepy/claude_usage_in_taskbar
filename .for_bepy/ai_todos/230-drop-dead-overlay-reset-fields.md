# Drop the now-dead reset fields from the overlay row model

**Type:** task

## Goal

Remove `resetAbs`, `resetRelative`, and `resetLabel` from `OverlayMetric`/`OverlayRow` in `src/views/overlay/overlay-logic.ts` (and the code that computes them), since nothing consumes them anymore.

## Context

The overlay hover used to show a per-window session tooltip (window name / time-left / absolute reset clock) built from these fields. That tooltip was removed in commit `c11d6e31` (FEAT: rework overlay dials) when the hover was changed to show only the account name + `5h`/`7d` current%/safe% inside the circle. `overlay-logic.ts` still computes:

- `OverlayMetric.resetAbs` / `OverlayMetric.resetRelative` (per 5h + 7d)
- `OverlayRow.resetLabel`

and `buildOverlayRow` still fills them (via `fmtResetDisplay`, the `timeLeft` helper, and the `sessionAbs`/`weeklyAbs` locals), but `overlay.ts` no longer reads any of them (verified: only producers exist, no consumers). Dead output introduced by the rework.

## Approach

- In `overlay-logic.ts`: drop the three fields from the `OverlayMetric`/`OverlayRow` interfaces, and remove their computation in `buildOverlayRow` (the `sessionReset`/`weeklyReset`/`sessionAbs`/`weeklyAbs`/`timeLeft`/`resetLabel` lines) if nothing else uses them. Keep `computeSafePacePct` (still used for `safePct`).
- Check `tests/overlay-logic.test.mjs` for assertions on the removed fields and update them.
- `pnpm tsc --noEmit` clean; run the overlay-logic vitest.

## Acceptance

- No `resetAbs`/`resetRelative`/`resetLabel` remain in the overlay module; typecheck + overlay-logic tests green; overlay hover still shows name + 5h/7d %/% (no behavior change).
