# Split pending-flow.ts — extract draft-storage helpers

## Goal

Pull the localStorage persistence helpers out of `src/views/sessions/pending-flow.ts` into a dedicated `pending-draft-storage.ts` (or similar) so pending-flow shrinks back below the project's informal 400-line ceiling.

## Context

`src/views/sessions/pending-flow.ts` is now 530 lines and mixes three concerns:

1. Draft pending session state-machine helpers (`discardDraft`, `resumeDraft`, `launchNewSession`, `startNewSession`).
2. The big `renderPendingPane` (HTML + composer wiring + SessionStarted swap + first-send `start_session` invocation + statusbar mount).
3. localStorage persistence: `PENDING_SESSION_KEY`, `savePendingSession`, `loadPendingSession`, `clearPendingSession` (added when persistence was wired in).

The persistence layer is the cleanest seam — it's pure, has no DOM/state coupling, just JSON serialization. Extracting it reduces pending-flow's surface and makes it easier to add more persisted fields later (see [[65-persist-draft-textarea-content]] which will add `draftText`).

## Approach

1. Create `src/views/sessions/pending-draft-storage.ts`. Move:
   - `PENDING_SESSION_KEY`
   - `savePendingSession(pending: PendingNewSession): void`
   - `loadPendingSession(): PendingNewSession | null`
   - `clearPendingSession(): void`
2. Import the type via `import type { PendingNewSession } from "./state";` at the top of the new file.
3. In `pending-flow.ts`, replace the inline definitions with `import { savePendingSession, loadPendingSession, clearPendingSession } from "./pending-draft-storage";`.
4. Run `npx tsc --noEmit` to confirm the imports are clean.
5. Use the `/commit` skill (don't shortcut to raw `git commit -m`).

## Acceptance

- `pending-flow.ts` line count back under ~470 lines (was 530 before split).
- `pending-draft-storage.ts` exists, exports the four symbols, has no DOM imports.
- All callers (`pending-flow.ts` and any future ones) import from the new module.
- Draft persistence still works end-to-end: open draft → reload page → draft row still in sidebar.
- TypeScript passes; no other files need changes.
