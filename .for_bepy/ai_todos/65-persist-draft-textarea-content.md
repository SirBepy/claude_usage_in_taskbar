# Persist draft textarea content across resume

## Goal

When the user navigates away from a `Draft New Chat` row and clicks it back via `resumeDraft`, the composer textarea should restore whatever text they had typed before navigating away.

## Context

Joe already added pending-session-object persistence to localStorage in `src/views/sessions/pending-flow.ts` (savePendingSession / loadPendingSession / clearPendingSession with key `pending-session:v1`). That persists the placeholder id, project, model/effort config, etc. — but NOT the composer's textarea content.

`resumeDraft` (`src/views/sessions/pending-flow.ts`) tears down the existing composer and calls `renderPendingPane`, which mounts a fresh `Composer` with empty textarea. Any in-progress prompt the user had typed is lost.

The unfinished offer from the session that introduced `resumeDraft`: "Textarea content isn't preserved across navigation — say the word if you want me to add draft-text persistence."

## Approach

1. Add a `draftText: string` field to `PendingNewSession` (`src/views/sessions/state.ts`).
2. Composer (`src/shared/chat/composer.ts`) should expose an `onTextChange` callback or similar so callers can subscribe to textarea-content changes. Check current composer API first - it likely already has something similar to debounce-save.
3. In `renderPendingPane` (the pending-flow `Composer` construction site), wire the textarea-change callback to:
   - Update `state.pendingNewSession.draftText`
   - Call `savePendingSession(state.pendingNewSession)` (debounce ~300ms to avoid LS write thrash on every keystroke).
4. After `renderPendingPane` mounts the composer, if `state.pendingNewSession.draftText` is set, populate the textarea with it. The composer probably already has a `setText(s)` or initial-value option.
5. Update `savePendingSession` / `loadPendingSession` to include the new field.

## Acceptance

- Open a new draft, type "hello world", click another chat row, click the Draft New Chat row → composer textarea shows "hello world".
- Type more, close the app, reopen → on first render, the same draft row exists and clicking it shows the typed text.
- Submitting the message (firstMessageSent → true) clears the draftText (or the entire pending session via existing path) so the next new chat starts fresh.
- Discard button still wipes everything cleanly.
