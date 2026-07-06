# Session Handoff

## What was accomplished

Investigated Joe's "Daemon Reconnected over and over" report by reading `%APPDATA%\claude-conductor\daemon.log` and the app-side `Claude Conductor.log` (under `%LOCALAPPDATA%\com.sirbepy.claudeconductor\logs\`). Found two distinct issues: (1) a real but rare named-pipe drop today (2026-07-01, 11:26:54 and 11:29:02) where the daemon process itself stayed alive the whole time (started 07:59:54, never restarted) - root cause of the pipe drop is not captured in current logs; (2) a toast-multiplication bug where `daemon-status-changed` is a single app-wide Tauri event but every window (main, Chats, per-session chat windows) loads the same `index.html`/`main.ts` and independently runs `initBoot()`, so each real disconnect/reconnect produces one toast per open window, which is likely why it felt like "over and over and over" from only 2 real events. Also surfaced (not today's bug, but same family) a historical ~2-hour crash-restart-loop from 2026-06-29 07:43-09:53 (386+ cycles), caused by the daemon's duplicate-spawn guard only checking the HTTP hooks port (127.0.0.1:27182) for health, not the named pipe - if the pipe ever dies while the HTTP port survives, no new daemon can take over. No code was changed this session; investigation only. Was about to ask Joe 3 clarifying questions (fix toast dedupe now? confirm sleep/lock at 11:26-11:29? add pipe-drop error logging?) via AskUserQuestion when the session was interrupted.

## Files changed

None (read-only investigation; `COMMENTS_FOR_BEPY.md` shows as modified in git diff but was not touched this session).

## Open decisions

- Whether to fix the toast-multiplication bug (scope `daemon-status-changed` toast to one place instead of every window independently reacting) - recommended, not yet approved by Joe.
- Whether the 11:26-11:29 pipe drop correlates with PC sleep/lock - unconfirmed, only Joe can answer.
- Whether to add I/O error detail logging to the reader task in `src-tauri/src/daemon_client/mod.rs` (currently only logs "connection lost", not the underlying `io::Error` kind) so the next pipe drop is diagnosable instead of guessed at.
- Whether the 6/29 duplicate-spawn-guard bug (health check only covers port 27182, not the named pipe) is worth fixing separately - not yet raised with Joe.

## Suggested next steps

- Re-ask Joe the 3 pending questions (toast dedupe fix, sleep/lock confirmation, add pipe-drop diagnostics) via AskUserQuestion - the previous attempt was interrupted before Joe answered.
- If toast dedupe is approved: scope the `api.onDaemonStatus` toast handling in `src/shared/boot.ts:270-279` so only one window (or a single dedicated status surface) shows the toast, not every webview.
- If diagnostics are approved: capture the actual `io::Error` in the reader task's `read_frame` failure branch in `src-tauri/src/daemon_client/mod.rs` (around line 78-81) and log it instead of the current generic "connection lost".
- Consider whether the 6/29 duplicate-spawn race (port-27182-only health check in `src-tauri/src/daemon/mod.rs`) warrants its own ai_todo, since it caused a 2-hour crash loop and could recur.
