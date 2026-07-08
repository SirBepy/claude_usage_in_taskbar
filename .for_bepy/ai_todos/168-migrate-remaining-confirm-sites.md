# Migrate remaining confirm() call sites to askConfirm

**Type:** task

## Goal
Replace every remaining `if (!confirm(...))` guard with the awaitable `askConfirm` helper (`src/shared/confirm.ts`), so destructive actions actually wait for the user's answer.

## Context
- Discovered 2026-07-08: Tauri patches `window.confirm` to the dialog plugin's `confirm` command, which returns a PROMISE. `if (!confirm(...))` therefore never blocks - the truthy Promise skips the guard and the destructive action runs with no confirmation shown. Real incident: account removal ran instantly, then the Promise rejected as an uncaught "dialog.confirm not allowed" (the capability was also missing `dialog:allow-confirm` - now added, along with `dialog:allow-message` for `alert()`).
- The accounts site (`accounts.ts` remove button) was fixed the same day with `askConfirm`. Remaining broken sites:
  - `src/views/sessions/active-session.ts:545` - take over manual session (kills an external claude process!)
  - `src/views/sessions/close-chat.ts:9` - discard an in-progress turn
  - `src/views/settings/subviews/permissions/permissions.ts:108` - remove all remembered permissions for a cwd
  - `src/shared/navigation.ts:110` - `window.confirm` guard, same problem
- Note the windows those views run in: the capability grant (`capabilities/default.json`, windows `main` + `session-*`) must cover each window, or the dialog rejects and askConfirm fails closed (action cancelled - safe but confusing). Check `chats` window capability if any of these render there.
- `src/views/sessions/sessions.ts:107` documents a deliberate no-confirm choice because the plugin used to be ACL-blocked; with `dialog:allow-confirm` now granted, reconsider whether that X should confirm.

## Acceptance
- All four sites await `askConfirm` and genuinely block until answered.
- Manual spot-check in the dev app: each dialog appears and Cancel aborts the action.
