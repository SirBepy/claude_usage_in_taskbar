# Move eventToRenderedMessage to chat-transforms

## Goal
Finish the chat-renderer.ts size reduction started in ai_todo 55. Current line count is 573; the acceptance target was under 550.

## Context
`src/shared/chat/chat-renderer.ts:287-310` defines `private eventToRenderedMessage(ev: ChatEvent): RenderedMessage | null`. It is a pure mapping function - no access to `this` state (only calls `cleanUserBlocks` from chat-transforms). It belongs alongside the other pure transforms in `chat-transforms.ts`.

After the ai_todo 55 work, `renderMessage` and `renderBlocks` already live in `chat-transforms.ts`. This method is the natural next piece. Moving it would bring `chat-renderer.ts` from 573 to ~549 lines, meeting the <550 target.

The method is called in two places in `chat-renderer.ts`:
- `prependEvents` (line ~241): `const msg = this.eventToRenderedMessage(ev);`
- `handleEvent` would need updating too if the method is promoted.

Actually `eventToRenderedMessage` is currently only called from `prependEvents`. `handleEvent` duplicates its own inline switch rather than calling it (a secondary DRY issue, but out of scope here).

## Approach
1. Move `eventToRenderedMessage` to `chat-transforms.ts` as `export function eventToRenderedMessage(ev: ChatEvent): RenderedMessage | null`.
2. Import `ChatEvent` in `chat-transforms.ts` (it already imports `ContentBlock` from the same file).
3. In `chat-renderer.ts`: import `eventToRenderedMessage` from `./chat-transforms`. Replace `this.eventToRenderedMessage(ev)` with `eventToRenderedMessage(ev)`.
4. `npx tsc --noEmit` clean.
5. Confirm `chat-renderer.ts` is under 550 lines.

## Acceptance
- `chat-renderer.ts` is under 550 lines.
- `eventToRenderedMessage` is exported from `chat-transforms.ts`.
- `npx tsc --noEmit` exits 0.
