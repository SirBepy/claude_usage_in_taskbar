# fetchOlder should prepend new DOM, not rebuild whole chat

## Goal

When the user scrolls up to load an older page, prepend rendered DOM nodes for the new slice. Do not call `bulkLoadEvents(allEvents)` which rebuilds every previously-rendered message from scratch.

## Context

`src/shared/chat/chat-renderer.ts::fetchOlder` currently does:

```ts
const allEvents = sessionEvents.events(sid);
await this.bulkLoadEvents(allEvents);
```

That means every `loadOlder` rebuilds the entire transcript DOM (markdown + dirty-tracking + flushRender) for messages that are already in the DOM. As the user scrolls back through 5+ pages, this gets quadratically worse and re-loses any shiki-highlighted code blocks (the `data-highlighted` guard saves shiki re-tokenization, but markdown is re-rendered).

## Approach

Refactor the renderer to track a "page boundary": after `loadInitial` mounts the first batch, remember the index in `messages[]` / `messageEls[]` where new content was prepended. In `fetchOlder`:

1. Pass only the prepended slice (the return value of `sessionEvents.loadOlder`) to a new method like `prependEvents(events: ChatEvent[])`.
2. In `prependEvents`, build a DocumentFragment of new message nodes from the slice, and `this.container.prepend(fragment)`. Update `this.messages = [...newSlice, ...this.messages]` and `this.messageEls` accordingly.
3. Move the existing scroll-anchor preservation (oldScrollHeight/oldScrollTop -> diff after) to surround the prepend.

The existing `bulkLoadEvents` stays for `loadFromStore` (initial mount, full reset) and `loadHistory` (History view).

Watch out for: the streamingIndex tracking, the dirtyIndices set, and how renderMessage handles `RenderedMessage` shape — `messages` and `messageEls` indices stay 1:1 if we always prepend at index 0.

## Acceptance

- `loadOlder` only renders the newly fetched page; existing rendered messages keep their DOM nodes (verify by tagging a node and confirming it survives across a page load).
- Scroll position still anchored to the user's viewport after prepend.
- Live-tail events appended to the chat continue to work unchanged.
- vitest: add a test that mocks two pages of older events, verifies `messageEls.length` grows by exactly the new slice size.
