# Fix chat-renderer-pagination test window stub

## Goal

`tests/chat-renderer-pagination.test.mjs` fails with `ReferenceError: window is not defined` at `src/shared/sidemenu.ts:18` because `sidemenu.ts` assigns to `window` at module-eval time, before any `beforeEach` can run.

## Context

The file uses a top-level `await import("../src/shared/chat/chat-renderer.ts")` which triggers `sidemenu.ts` evaluation before `globalThis.window` is set. The streaming test (`chat-renderer-streaming.test.mjs`) has the same import pattern and already fixes this with a one-line stub before the imports:

```js
if (!globalThis.window) {
  globalThis.window = {};
}
```

This is a pre-existing failure unrelated to the ai_todo 47 session.

## Approach

Add the same two-line stub to `tests/chat-renderer-pagination.test.mjs` before the top-level `await import(...)` line (after `vi.mock`):

```js
if (!globalThis.window) {
  globalThis.window = {};
}
const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
```

## Acceptance

- `npx vitest run tests/chat-renderer-pagination.test.mjs` passes (currently 0 tests collected, fails on import).
- No other test files touched.
