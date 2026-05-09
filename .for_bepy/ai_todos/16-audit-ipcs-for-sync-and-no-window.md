# Audit all #[tauri::command] sites for sync-on-runtime + missing CREATE_NO_WINDOW

## Goal

Sweep the IPC surface so no command blocks the Tauri runtime thread on disk / process IO, and every Windows process spawn flags `CREATE_NO_WINDOW`. The chat-open freeze fix surfaced one such command (`get_git_info`); there are likely more.

## Context

This session shipped `FIX: get_git_info async + CREATE_NO_WINDOW kills console flashes and UI freeze on chat open` (commit 23e32bb). The bug was a sync `#[tauri::command]` that spawned `git` twice on the runtime thread without the no-window flag. The user observed:
- "lil terminals popping up for a split second"
- UI couldn't resize / switch chats during the freeze.

Other suspect commands to audit:
- `src-tauri/src/ipc/projects.rs:249` (explorer), `:257` (open), `:262` (xdg-open), `:273` (cmd), `:281` (code) — user-initiated buttons; CREATE_NO_WINDOW for `cmd`/`code` matters on Windows.
- `src-tauri/src/auth/login_flow.rs:64` (which), `:94` (chrome bin), `:118` (taskkill).
- Any `#[tauri::command] pub fn ...` (sync) that does file IO, process IO, or DB access.

## Approach

1. `grep -n "#\[tauri::command\]" src-tauri/src/` — list every command.
2. For each command, check:
   a. Is it `pub fn` (sync) or `pub async fn`? Sync commands run on the runtime thread.
   b. Does the body do filesystem walks, process spawns, network IO, blocking locks?
   c. If yes to (a)+(b): wrap the body in `tauri::async_runtime::spawn_blocking` and make the command async.
3. `grep -n "Command::new" src-tauri/src/` — every spawn site.
4. For each spawn, check for `creation_flags(CREATE_NO_WINDOW)` under `#[cfg(windows)]`. If missing, add it (preferably via the shared helper from ai_todo #12).

This audit is best done after #12 lands so the CREATE_NO_WINDOW fix is a one-line `crate::util::process::hide_console(&mut cmd)` call rather than a copy-paste of the cfg block.

## Acceptance

- A list of every IPC command, marked sync vs async, with sync+blocking ones converted.
- Every `Command::new` site on Windows has the no-window flag.
- Manual: open chats, kick off all left-sidebar buttons, click "Open in VS Code", "Open folder", trigger login flow — none flash a console window, none freeze the UI.
