# Mobile PWA can't start new chats - accounts not shared (FIX SHIPPED, needs phone confirm)

Type: Fix

## Status (2026-07-12, autopilot)

FIX IMPLEMENTED + unit-tested, committed `cd831041`. Only a live phone confirmation
remains (a physical action Claude can't do unattended).

## What was wrong

Root cause (traced end-to-end): the phone's new-chat account picker calls `list_accounts`,
but the daemon's remote-access server never routed it. On mobile, `HttpTransport.call`
fell through to `RemoteUnavailableError`; `api.listAccounts()` swallowed it and returned `[]`;
`account-field.ts`'s `accountPickIncomplete` (`accounts.length === 0` → true) left the
"Start session" button permanently disabled. So no chat could be started from mobile.

## What was done

- `src-tauri/src/daemon/methods/registry.rs`: registered `list_accounts` on the RPC router,
  returning `json!(crate::accounts::load_registry())` - the same on-disk `accounts.json` the
  daemon already reads to resolve `start_session`'s `account_id`. Byte-identical shape to the
  desktop `list_accounts` Tauri command (frontend `Account[]`).
- `src-tauri/src/daemon/remote_handlers.rs`: added `list_accounts` to the read-only
  `SAFE_METHODS` allowlist (+ its allowlist test). No account MUTATORS exposed to the phone.
- `src/shared/http-transport.ts`: added the `case "list_accounts"` route.
- `src-tauri/src/daemon/methods/mod.rs`: `list_accounts_dispatches_to_registered_handler`
  test (guards against a future "allowlisted but forgot to register" regression).

`start_session` was already routed and already forwards `account_id`, so listing accounts is
the whole fix - no spawn-path change needed.

## Verified

- `cargo test --lib` daemon suite: 108 pass incl. the new dispatch + allowlist tests.
- `tsc --noEmit`: clean.
- NOT verified: the live HTTP round-trip on Joe's actual phone (needs the device + network).

## Remaining: confirm on phone

Open the PWA on the phone, start a new chat: the account picker should now list the same
accounts as desktop and "Start session" should enable. If it works, delete this file.

If it STILL fails: the new-chat flow was traced and `list_accounts` was the only unrouted
command, but re-check for any OTHER command the mobile flow hits that isn't in `SAFE_METHODS`
/ `HttpTransport` (watch the phone's browser console for `RemoteUnavailableError`). Related
app-process-only state deliberately left unrouted (not needed by new-chat): `get_usage_map`,
`get_auth_state_map` (live only in Tauri AppState, written by the app's poll loop).
