# Split chat-renderer.ts (850 lines, many concerns)

## Goal
Reduce `src/shared/chat/chat-renderer.ts` (currently 850 lines) by extracting cohesive units, so the file holds one clear responsibility.

## Context
`ChatRenderer` mixes: live event routing (`handleEvent`), DOM diff/flush (`flushRender`), turn-collapse `<details>` grouping (`applyTurnCollapse`/`processTurnCloseQueue`), the long-message clamp (`clampUserMessages`), turn-status capture (`setTurnStatus`), pagination/top-sentinel (`installTopSentinel`/`fetchOlder`/`prependEvents`), and three click handlers (copy/slash/attachment/pasted-log). Surfaced by `/close` size check; pre-existing, not introduced by the recent feature work.

## Approach
Extract the clearest seams into sibling modules the renderer composes/calls:
- Turn-collapse grouping → `turn-collapse.ts` (pure-ish DOM ops over a messageEls/messages slice).
- Pagination/top-sentinel → `chat-pagination.ts`.
- Click handlers (copy/slash/attachment/pasted-log) → a `chat-click-handlers.ts` wired in the constructor.
Keep `ChatRenderer` as the orchestrator owning state (`messages`, `messageEls`, `streamingIndex`).

## Acceptance
`chat-renderer.ts` drops well under ~500 lines; all existing chat-renderer tests (streaming, pagination, edits, activity) still pass; no behavior change.
