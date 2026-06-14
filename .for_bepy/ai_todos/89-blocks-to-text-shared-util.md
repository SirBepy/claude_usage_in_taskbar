# Extract a shared blocksToText(ContentBlock[]) util

## Goal
De-duplicate the "join a ContentBlock[]'s text blocks into a string" one-liner that now lives in four places.

## Context
The same shape is copy-pasted:
- `src/shared/chat/held-messages.ts:44` (`blocksToText`, the canonical version with the `b &&` guard + `.filter(Boolean)`)
- `src/views/sessions/pending-pane.ts:161` (inline `promptText` build, identical)
- `src/shared/chat/chat-renderer.ts:482` and `:487` (slightly looser: no null-guard, no filter)

Low severity - it's a trivial map/filter/join - but four copies that can drift is worth one shared helper.

## Approach
Add `export function blocksToText(blocks: ContentBlock[]): string` to a small shared module (e.g. `src/shared/chat/content-blocks.ts`, or co-locate it as an export on an existing chat util). Use the held-messages version (guarded + filtered) as the canonical body. Replace the held-messages local copy, the pending-pane inline `promptText` build, and the two chat-renderer sites with imports. Confirm the chat-renderer sites tolerate the `.filter(Boolean)` (they currently keep empty strings then join - filtering empties is fine for display joins, but eyeball the two cases).

## Acceptance
- One `blocksToText` definition; the other three sites import it.
- `pnpm tsc --noEmit` clean, `pnpm vitest run` green (esp. held-messages.test.mjs and any chat-renderer tests).
- No behavior change in the rendered transcript or the held-message bundling.
