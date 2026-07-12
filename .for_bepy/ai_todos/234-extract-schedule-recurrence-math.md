# Extract schedule calendar recurrence/date math into its own module

**Type:** code-health

## Goal
Split the pure date + recurrence math out of `src/views/schedule/schedule.ts` (630 lines) so the view file holds only rendering + mount/action wiring.

## Context
The 2026-07-12 calendar rewrite pushed `schedule.ts` to 630 lines. It mixes two clearly separable concerns:
- Pure, testable helpers: `parseHhmm`, `nextOccurrence`, `expandRecurrence`, `gridRange`, `dayKeyOf`, `localTime`, `dateFromHumanTime`, `buildOccurrences` (schedule.ts, roughly lines 90-230). `nextOccurrence`/`expandRecurrence` are a TS port of the Rust `next_occurrence` in `src-tauri/src/sessions/scheduled_items.rs` - a self-contained unit that deserves its own unit tests.
- View concern: lit-html templating, grid/agenda rendering, mount, event wiring, `handleAction`.

## Approach
Extract the pure helpers into `src/views/schedule/schedule-recurrence.ts` (or `schedule-dates.ts`), export them, and import into `schedule.ts`. No behavior change. Consider adding a small vitest for `nextOccurrence`/`expandRecurrence` mirroring the Rust test cases (daily/weekly/every-N, DST-agnostic since JS uses local Date).

## Acceptance
- `schedule.ts` under ~450 lines, imports the math module.
- `pnpm tsc --noEmit` clean.
- Calendar still renders month grid + agenda + recurrence dots identically (relaunch, open Schedule window).
