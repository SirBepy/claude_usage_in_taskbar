# Mobile PWA can't start new chats - not sharing PC state (accounts)

Type: Fix

## Goal

The remote/mobile PWA (phone browser hitting the daemon's remote-access server) can't start
new chats, because it doesn't have the state the desktop app has. Most important missing
piece per Joe: the ACCOUNTS aren't shared, so the phone has nothing to spawn a chat against.
Make the mobile PWA see the same accounts (and whatever else new-chat needs) the PC has.

## Context

Flagged by Joe 2026-07-12 mid-session (while building the view-harness): "i cant start new
chats on mobile cuz mobile doesnt seem to be sharing everything from the pc... most important
being that it doesnt share the accounts."

Root cause is almost certainly the HttpTransport coverage gap: the frontend calls ~164 IPC
commands, but the daemon's remote-access server (`src-tauri/src/remote_server.rs`, :27183,
what `HttpTransport` in `src/shared/http-transport.ts` talks to) only implements ~26 of them.
Account commands (`list_accounts`, `get_usage_map`, `get_auth_state_map`, and the
new-chat/spawn path) are very likely NOT among the routed 26 - so on the phone those calls
fail/return empty and the account picker (and thus new-chat) has nothing to work with.

Note the deeper wrinkle found during the harness work (see iterate-it session): a chunk of
frontend commands are backed by IN-PROCESS state in the Tauri APP process
(e.g. characters cache), which the daemon (a separate OS process) can't read no matter how
the request is routed. Accounts need checking: is account state daemon-owned (routable) or
app-process-owned (needs the daemon to own/duplicate it, or a bridge)? That determines
whether this is "add remote routes" or "move/duplicate state into the daemon."

Relevant files:
- `src-tauri/src/remote_server.rs` - the :27183 HTTP/WS routes HttpTransport hits
- `src/shared/http-transport.ts` - the ~26-command switch; what the phone can call
- `src-tauri/src/daemon/rpc.rs` - name-keyed Router (no generic dispatch)
- account IPC commands in `src-tauri/src/ipc/` (list_accounts, spawn/new-chat path)
- `src/views/sessions/` - the new-chat entry the phone uses

## Approach

1. On the phone (or the headless-daemon Playwright mobile harness), open the new-chat flow and
   capture which commands fail / return empty. Confirm `list_accounts` (and the spawn path) is
   in the gap.
2. Determine where account state lives: daemon-owned (then add remote_server routes + rpc
   registrations) vs app-process-owned (then decide bridge vs move state daemon-side).
3. Implement the smallest fix that lets the phone list accounts and start a new chat against
   the correct account. Extend the contract so the mobile new-chat path has parity with desktop.

## Success criteria

- On the phone PWA, the account picker shows the same accounts as the desktop.
- Starting a new chat on the phone works and attributes to the chosen account.
- Verified against a real phone or the headless-daemon mobile Playwright harness
  (see project memory: test-phone-view-headless-daemon), not just by assertion.
