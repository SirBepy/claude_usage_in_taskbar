# Drop dead `editIndexes` field on `DedupedRow`

## Goal

Remove the `editIndexes: number[]` field from `DedupedRow` in `src/views/sessions/changes-panel.ts`. It's written by `dedupeByPath` but never read anywhere except the test.

## Context

When the changes-panel was designed, `editIndexes` was meant to let row-click compute which edits belong to the deduped file. In the actual implementation, the sheet renderer uses `this.edits.filter((e) => e.path === path)` directly, never indexing. The field is YAGNI debt.

## Approach

1. Remove `editIndexes` from the `DedupedRow` interface in `src/views/sessions/changes-panel.ts`.
2. Remove the assignment + push in `dedupeByPath`.
3. Delete `expect(out[0].editIndexes).toEqual([0]);` and the equivalent in the dedupe test (`tests/changes-panel.test.mjs`).
4. Re-run `npx vitest run tests/changes-panel.test.mjs` — should stay at 4/4 green.

## Acceptance

- `editIndexes` grep across `src/` returns 0 hits.
- 4/4 panel tests pass.
