# Verify first-turn streaming renders live

## Goal

Confirm that on a brand-new chat (`+ New` → pick project → type → send), the assistant's reply text streams into the pane token-by-token AS it arrives, NOT only after `start_session` resolves and `selectSession`'s `load_history` replays the JSONL post-hoc. If it doesn't actually stream live, fix it.

## Context

The placeholder/swap-subscription mechanism added this session (commit `7fa710e`, refined in `38706fc` and `29af815`) was supposed to fix the first-turn streaming gap. The mechanism:

1. Frontend generates a `placeholder-<ts>-<rand>` id and sets `state.pendingNewSession = { placeholderId, ... }`.
2. `renderPendingPane` attaches a `ChatRenderer` to `chat:<placeholderId>` BEFORE invoking `start_session`.
3. `Composer.onSend` calls `invoke("start_session", { cwd, prompt, placeholderId })`.
4. Rust `run_session_turn` uses the supplied placeholder as the cancel-slot key and (when SessionStarted is captured) emits the SessionStarted event on `chat:<placeholder>` so the frontend listener captures the real id and calls `state.renderer.swapSubscription(realId)`.
5. Subsequent stream events fire on `chat:<realId>` and the renderer (now subscribed there) renders them live.

This SHOULD work. But I never end-to-end tested with a fresh visible session. The earlier "Known unfinished" caveat I posted — "first-turn streaming events fire before frontend subscribes" — was partially addressed by this mechanism but not visually verified.

Joe's recent pasted log showed `parser: unrecognised line: stream_event` lines for the first turn. That issue was the parser dropping `stream_event` envelopes (commit `77ffd7f` fixed it: parser now accumulates `text_delta` chunks). With both fixes, first-turn streaming SHOULD render live now. But verify.

Relevant files:
- `src/views/sessions/sessions.ts:420-560` (`renderPendingPane`, the placeholder listener at ~line 460)
- `src/shared/chat/chat-renderer.ts` (added `swapSubscription` + `currentSessionId`)
- `src-tauri/src/ipc/chat.rs:104-200` (placeholder logic, SessionStarted mirroring on placeholder channel)
- `src-tauri/src/chat/parser.rs:9-95` (`stream_event` text_delta accumulator)

## Approach

1. `cargo tauri dev`. Open Sessions view.
2. Click `+ New`, pick a project (the modal flow), type `say hi`, hit Enter.
3. Watch the pane: the assistant's reply should appear character-by-character (or in small chunks) WITHIN ~1-3s of sending, not appear all-at-once after a longer pause.
4. If it streams live → close this todo, the mechanism works.
5. If it pauses ~5-15s and then dumps the whole reply at once → the renderer isn't seeing live `chat:<placeholder>` events. Diagnose:
   - Open the Tauri devtools console; log `chat:<placeholderId>` event arrivals from `chat-renderer.ts::handleEvent`.
   - Check whether Rust is emitting on the right channel: temporarily log `target` in `ipc/chat.rs::run_session_turn` closure (line ~196) to console.
   - Most likely culprit: the `swapSubscription` happens BEFORE the renderer has finished subscribing to placeholder. There's an `await renderer.attach(placeholderId)` in `renderPendingPane` line ~447; check that the listener at line ~460 also `awaits` properly.

## Acceptance

- A fresh `+ New` session shows assistant text streaming in within 1-3s of send, with visible character-by-character growth.
- Subsequent turns in the same session continue to stream live (this was already working; don't regress).
- No console errors about missing event listeners or duplicate subscriptions.
- 207 cargo tests still pass; existing parser stream_event tests cover the wire format, but a manual end-to-end is the only way to verify the frontend wiring.
