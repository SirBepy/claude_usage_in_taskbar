# Optional toggle to hide Bash/PowerShell from the ccstatusline tally

## Goal

Let the user hide the `Ran xN` (Bash/PowerShell) chip from the ccstatusline tool-tally row, while still counting Bash in the in-chat transcript rows.

## Context

Shipped 2026-06-10: the tally row (`src/views/sessions/session-statusbar.ts`, fed by `ChatRenderer.onToolTally` / `tool-meta.ts ToolTally`) counts Bash/PowerShell as `Ran xN` in BOTH the transcript compact rows and the ccstatusline aggregate. At design time Joe said Bash counting is "not really necessary" in the statusline but fine to keep in-chat — "maybe we can turn it off from ccstatusline." So this is an opt-out, not a removal.

## Approach

Add a boolean setting (e.g. `tallyHideBash`, default false = keep showing) in the existing settings store. In `updateToolTally`, filter Bash/PowerShell out of `byType` for the statusline row when the setting is on (leave transcript rows untouched). Surface the toggle wherever statusline fields are configured (the statusline settings subview) or a small control on the row itself. Keep it cheap.

## Acceptance

- A setting hides the `Ran xN` chip from the ccstatusline row only; transcript Bash rows still render.
- Default behavior unchanged (Bash still shown) until the user opts out.
- `pnpm tsc --noEmit` clean.
