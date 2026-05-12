# Extract renderMessage and renderBlocks from ChatRenderer into chat-transforms

## Goal
Reduce `chat-renderer.ts` from 633 lines by moving the HTML-rendering methods into `chat-transforms.ts`, where the other pure string-building helpers already live.

## Context
`src/shared/chat/chat-renderer.ts` is 633 lines. After the Phase 2 split (ai_todo 51), `renderMessage` and `renderBlocks` remain as private class methods, but they have no access to ChatRenderer private state - they only take a `RenderedMessage` or `ContentBlock[]` argument and return a string. They belong with the other pure transforms in `chat-transforms.ts`.

Blocker: `RenderedMessage` is currently a `private interface` in chat-renderer.ts. It must be promoted to `export interface` and moved to chat-transforms.ts for the free functions to use it.

## Approach
1. Move `interface RenderedMessage` from `chat-renderer.ts` to `chat-transforms.ts` as `export interface RenderedMessage`.
2. Move `renderMessage(m: RenderedMessage): string` to `chat-transforms.ts` as `export function renderMessage(m: RenderedMessage): string`.
3. Move `renderBlocks(blocks: ContentBlock[]): string` to `chat-transforms.ts` as `export function renderBlocks(...)`. Update its call inside `renderMessage` accordingly.
4. In `chat-renderer.ts`: import `RenderedMessage`, `renderMessage`, `renderBlocks` from `./chat-transforms`. Replace `this.renderMessage(m)` with `renderMessage(m)` in `buildMessageEl`.
5. `pnpm tsc --noEmit` clean.

## Acceptance
- `chat-renderer.ts` is under 550 lines.
- `RenderedMessage` is exported from `chat-transforms.ts`.
- No TS errors.
