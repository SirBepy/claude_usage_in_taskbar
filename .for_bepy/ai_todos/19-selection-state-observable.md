# Replace setSelectedSessionId direct setter with selection-state observable

## Goal

Eliminate the parallel-arrays risk between `state.selectedId` mutations in `sessions.ts` and the corresponding `setSelectedSessionId()` calls into `permission-modal.ts`. A future 7th mutation that forgets the sibling call would silently break the chat-hub permission modal (events would arrive but be gated out by stale `_selectedSessionId`).

## Context

Today the wiring looks like this in `src/views/sessions/sessions.ts` (6 sites):

```
state.selectedId = sessionId;
setSelectedSessionId(sessionId);
```

`setSelectedSessionId` lives in `src/views/sessions/permission-modal.ts:210-212` and just mutates a module-level `_selectedSessionId`. The codebase already has a pub/sub primitive in `src/shared/chat/event-store.ts` (`subscribe`/`unsubscribe`).

Risk: any new code path that mutates `state.selectedId` and forgets the sibling call will silently suppress every permission/question modal for that session, with no compile-time or test-time signal.

## Approach

Two viable shapes:

1. **Encapsulate state.** Replace `state.selectedId = X` direct assignments with a `setActiveSession(id)` helper inside `sessions.ts` that mutates state AND notifies subscribers. `permission-modal.ts` subscribes once at install time. Smallest diff; keeps state colocated.

2. **Move the truth out.** Promote selected-session-id into a small `selection-store.ts` (mirroring `event-store.ts` shape) with `getActive() / setActive() / subscribe()`. Both `sessions.ts` and `permission-modal.ts` (and any future consumer) talk to the store. Cleaner long-term; bigger diff.

Recommend (1) for now: it solves the divergence risk without introducing a new module. Migrate to (2) only if a third consumer appears.

## Acceptance

- No callsite outside `sessions.ts` (or wherever the helper lives) writes `state.selectedId` directly. Grep returns only the helper definition + accessor reads.
- `permission-modal.ts` subscribes to selection changes via the helper / store, not via a direct setter import.
- Manually verifying the chat hub: select session A, send a message that triggers an Edit permission, modal pops. Switch to session B mid-flight, modal for A's outstanding request does NOT auto-target B.
- No regression in detached-window mode (the listener still installs and gates correctly there).
