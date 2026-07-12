# Dead code: SessionStatusbar.setAccountId

## Goal
Either wire up `SessionStatusbar.setAccountId` to a real update path, or delete it.

## Context
`src/views/sessions/session-statusbar.ts:267` adds `setAccountId(accountId: string | null): void`,
mirroring the existing `setReadOnlyEffort` pattern, so the statusline's account chip could be
live-updated without a full pane remount. It is never called anywhere - a chat's account only
ever changes via a full rebind (takeover or `moveSessionToAccount`, both of which already remount
the pane via `selectSession`, which reconstructs the `SessionStatusbar` from scratch with the new
`accountId` in its constructor options). At the time it was added, this was a deliberate "mirror
the existing setter shape, skip wiring since there's no live-update path yet" call - see
`src-tauri: FEAT: show and control which account a chat runs under` (commit `cf762955`).

## Approach
Delete `setAccountId` (and its doc comment) unless a live-update path materializes - e.g. if a
future feature changes an `Instance.account_id` in place without a session-id change (no such path
exists today per `chat/takeover.rs` and `move_session_to_account`, both of which mint a new
session id).

## Acceptance
- `grep -rn "setAccountId" src/` returns zero matches after the fix (either deleted, or a real
  caller now exists).
- `pnpm tsc --noEmit` passes.
