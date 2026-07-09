# Window/virtualize the chat message DOM (and pause off-screen infinite animations)

**Type:** task

## Goal

Cap the number of message elements mounted per chat pane so long transcripts stop growing DOM/reflow cost forever, and stop `infinite` CSS animations running in old off-screen messages.

## Context

From the 2026-07-09 performance audit. The message list is append-only and never detaches off-screen rows: `src/shared/chat/chat-renderer.ts` / `chat-pagination.ts` (`messageEls` grows without bound as `ChatPaginator` prepends older pages). Per-flush passes were already scoped to touched elements (commit c54a1ffd), so the remaining cost is raw DOM node count, layout/reflow, and `.rainbow-keyword` (`src/shared/chat/chat-messages.css:51-60`, applied by `chat-transforms.ts:300`) running `animation: rainbow-shift 1.8s linear infinite` in every mounted old message that contains the "ultrathink" keyword. Deferred because it is regression-prone (scroll anchoring, pagination interplay) and the rest of the audit's fixes were higher value per risk.

## Approach

- Add windowing to the message container: when scrolled well past an element (e.g. >2 viewport heights), replace it with a fixed-height placeholder div and re-hydrate on approach (IntersectionObserver sentinel per side). Keep `messageEls` indices stable - store the event data needed to rebuild.
- Alternative rejected: full virtual list rewrite (react-window style) - too invasive for vanilla DOM renderer.
- Cheap first step if windowing proves hairy: IntersectionObserver toggling `animation-play-state: paused` on `.rainbow-keyword` (and the session-avatar pulse classes) when off-screen.

## Acceptance

- A 500+ message transcript keeps mounted node count roughly constant while scrolling.
- Streaming render, pagination (load-older), scroll-to-bottom on new message, and turn-collapse must not regress - the vitest chat-renderer/chat-reconcile suites stay green, plus a manual long-session scroll test.
- No infinite animation runs for elements outside the viewport (check DevTools performance recording).
