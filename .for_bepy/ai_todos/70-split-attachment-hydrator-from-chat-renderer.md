# Split attachment hydrator out of chat-renderer.ts

## Goal
Extract the module-level attachment hydration logic from `chat-renderer.ts` into a focused `attachment-hydrator.ts` module.

## Context
`chat-renderer.ts` is 745 lines. The three module-level items added in the attachment overhaul — `chipData` (WeakMap), `hydrateAttachments`, and `chipToLightboxContent` — are a self-contained hydration concern that has nothing to do with the renderer's core job of mapping `ChatEvent` streams to DOM nodes. They live at `src/shared/chat/chat-renderer.ts:23-63`.

## Approach
1. Create `src/shared/chat/attachment-hydrator.ts` and move `chipData`, `hydrateAttachments`, `chipToLightboxContent` into it.
2. Export `hydrateAttachments` and `chipToLightboxContent`; keep `chipData` module-private (unexported WeakMap).
3. Update `chat-renderer.ts` to import `hydrateAttachments` and `chipToLightboxContent` from `./attachment-hydrator`.
4. No logic changes — pure file split.

## Acceptance
- `chat-renderer.ts` drops to ~700 lines.
- `attachment-hydrator.ts` has one clear responsibility: load attachment data and expose lightbox content.
- All existing attachment chip + lightbox behaviour works identically after the split.
