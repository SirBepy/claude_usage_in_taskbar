# Thread accountId through the open_chats_new_chat path

**Type:** task

## Goal
New chats started via the Chats-window "+" (project-detail's open_chats_new_chat path) should honor the account picked in the model/effort modal instead of silently falling back to the default account.

## Context
Found during multi-account M04 (2026-07-07): the `open_chats_new_chat` path already dropped `autoAccept`/`remote`/`characterId` from the modal's SessionConfig before multi-account existed (pre-existing lossy tuple), and `accountId` was deliberately not added to it to avoid widening the fix's scope. See `src/views/project-detail/project-detail.ts` (the "+" handler) and the tuple it forwards; the modal produces `SessionConfig.accountId` (src/shared/effort-presets.ts) which `pending-pane.ts` forwards correctly on the normal path.

## Approach
Replace the lossy positional tuple with the full SessionConfig object (or add the missing fields), through the open_chats_for_session/new-chat IPC into the Chats window, so accountId, autoAccept, remote, and characterId all survive. Fixing all four at once is the right scope since the plumbing is shared.

## Acceptance
Starting a chat from the Chats-window "+" with a non-default account selected in the modal spawns under that account (verify via the session's account attribution in the sidebar/chat-config.json), and the character/auto-accept picks survive too.
