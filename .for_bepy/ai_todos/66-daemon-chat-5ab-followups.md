# Daemon chat 5a/5b follow-up bugs (for the post-5b bug-fix pass)

**Severity:** low-medium. Both are flag-on (`useDaemon=true`) only; experimental, default off.

Two known issues deferred to the bug-fix pass that comes before Phases 6/7:

## 1. `useDaemon` settings toggle does not persist
The Task 8 toggle (`src/views/settings/settings.ts` + `src/shared/settings-save.ts`) was added but clicking it did NOT write `useDaemon: true` to settings.json (it stayed false across app restarts). For testing, the flag was forced on by hand-editing `%APPDATA%\claude-usage-tauri\settings.json`. Root cause unconfirmed - check the hydrate/read + the `chkOr("useDaemon", ...)` save path actually round-trips (compare against a working toggle like `launchAtLogin`). Without this, the daemon path is not switchable from the UI.

## 2. `attached_sessions` bridge-pump leak on session death
`src-tauri/src/ipc/chat/daemon_bridge.rs`: the app-side bridge pump task blocks on `rx.recv()`; that mpsc receiver only closes when the client's `subs` entry (`daemon_client/mod.rs:139`) is replaced by a NEW `attach_session`. When a daemon session ends normally (end_session / crash / daemon restart) and is never re-attached, the `tx` is never dropped, so the pump task blocks forever and the id is never removed from `attached_sessions`. Slow unbounded growth of dead tasks + set entries over a long app session. The `reattach()` fix (commit 21c2a36) handles the cancel-then-continue respawn case, but a long-lived idle ended session still leaks one task. Fix: have the daemon drop/close the per-app subscription when a session ends (so `rx.recv()` returns None and the existing cleanup runs), or drain `subs`/`attached_sessions` on the `instances_changed`-ended signal.

## Also in the bug-fix pass (tracked elsewhere)
- ai_todo 65 (chat reload re-appends synthetic user messages; pre-existing).
- Re-enable `jsonl_tail` (phone-convergence) WITH uuid-based dedup before it can double-publish (it is currently NOT spawned; see daemon/lifecycle.rs comment).
