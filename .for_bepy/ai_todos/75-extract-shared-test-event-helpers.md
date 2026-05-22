# Extract shared test event helpers to tests/helpers/chat-events.mjs

## Goal

`userEvent` is defined identically in 3 test files. `assistantEvent` is defined identically in 2. Extract to a shared module so new test files don't repeat the definition.

## Context

Current duplicates:
- `tests/event-store.test.mjs:14` — `userEvent`, `assistantEvent`
- `tests/chat-renderer-pagination.test.mjs:34` — `userEvent`, `assistantEvent`
- `tests/chat-renderer-streaming.test.mjs:50` — `userEvent`, `finalEvent`, `streamingEvent`

`userEvent` and `assistantEvent` shapes are identical across all files (same field names, same defaults).

## Approach

1. Create `tests/helpers/chat-events.mjs` exporting: `userEvent`, `assistantEvent`, `streamingEvent`, `finalEvent`.
2. Replace the local definitions in all 3 test files with `import { userEvent, ... } from "./helpers/chat-events.mjs"`.
3. `finalEvent` and `streamingEvent` currently only exist in `chat-renderer-streaming.test.mjs`; move them to the helper anyway for future tests.

## Acceptance

- `npx vitest run` passes all currently-passing tests.
- No local `function userEvent` / `function assistantEvent` definitions remain in the 3 test files.
- `tests/helpers/chat-events.mjs` exports all 4 helpers with correct types.
