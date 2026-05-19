# Extract shared basename() helper for path-split logic

## Goal

Replace 5 ad-hoc `path.split(/[\\/]/).pop()` sites with one imported helper.

## Context

Five sites now do the same Windows/Unix basename derivation:
- `src/shared/chat/file-edits.ts` — `basenameOf()` (private)
- `src/shared/chat/chat-renderer.ts` — inline in `describeActivity()`
- `src/shared/chat/chat-transforms.ts:32` — inline in attachment-chip render
- `src/shared/chat/attachment-hydrator.ts` — inline
- `src/views/settings/subviews/notifications/notifications.ts` — inline

All return `parts[parts.length - 1] ?? p`. The duplication is harmless individually but a sixth site is one Edit away.

## Approach

1. Create `src/shared/path-utils.ts` with `export function basename(p: string): string`.
2. Replace each site with `import { basename } from "<relative>/path-utils";` and `basename(path)`.
3. `file-edits.ts` `basenameOf` becomes a one-line wrapper or gets deleted entirely.
4. Add a tiny vitest `tests/path-utils.test.mjs` covering Windows + Unix paths + trailing slash.

## Acceptance

- All 5 sites import from `path-utils`.
- `parseFileEdit` returns the same `basename` for Windows and Unix inputs (existing test stays green).
- No new top-level symbols introduced beyond `basename`.
