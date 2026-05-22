# Fix stale value="live" assertion in projects_view test

## Goal

`tests/projects_view.test.mjs` fails because it asserts `value="live"` exists in the projects sort-by dropdown template, but that option was removed. The test is stale.

## Context

`tests/projects_view.test.mjs:52` does:
```js
expect(projectsTs).toMatch(/value="live"/);
expect(projectsTs).toMatch(/value="tokens"/);
```

The current template in `src/views/projects/projects.ts` only has:
```html
<option value="recent">Recently used</option>
<option value="name">Name</option>
```

No `live` or `tokens` options exist. These were removed at some point and the test was not updated.

## Approach

Two options:
1. **Remove the stale assertions** (lines 52 and 54 of `tests/projects_view.test.mjs`) - correct if `live` and `tokens` sort were intentionally removed.
2. **Re-add the options to the template** - correct if they were accidentally dropped.

Check git history for when `live`/`tokens` options were removed and whether it was intentional. If intentional: delete the two assertions. If accidental: restore the template options and the sort logic.

## Acceptance

- `npx vitest run tests/projects_view.test.mjs` passes all 10 tests.
- If assertions removed: no `value="live"` / `value="tokens"` assertions remain.
- If options restored: the dropdown renders with live/tokens/recent/name options.
