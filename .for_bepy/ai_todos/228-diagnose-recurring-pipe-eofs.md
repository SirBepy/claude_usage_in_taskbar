# Diagnose the recurring daemon pipe EOFs using the new connection logging

**Type:** task

## Goal

Find out who/what drops the app<->daemon pipe connection every few minutes. The GUI log (`%LOCALAPPDATA%\com.sirbepy.claudeconductor\logs\Claude Conductor.log`) shows `daemon pipe reader stopped: io error kind=UnexpectedEof` + `daemon connection lost; respawning + reconnecting` at 14:18, 14:20, 14:23 (x2), 14:30, 14:32, 14:34, 14:54, 15:53 on 2026-07-11, while daemon.log shows the daemon never restarted (alive since 12:35:59). So the connection dies while both processes live.

## Context

Discovered during the 2026-07-11 wedge post-mortem (see memory `project_wedge_incident_2026_07_11`). At the time, clean connection closes were logged NOWHERE daemon-side: `serve_connection`'s `Ok(())` exit was silent and `FrameError::TooLarge` logs at debug. That's fixed now: `src-tauri/src/daemon/transport_windows.rs` logs `client pid X connected` (debug) / `client pid X disconnected` (info) / `connection ended with error: ... (pid X)` (warn), and unix has parity. Also fixed in the same commit: `transport_common.rs` now dispatches RPCs concurrently (responses through the outbound queue) instead of head-of-line blocking the connection - the old inline await meant one slow handler (start_session spawning claude.exe) stalled every RPC + notification on the connection, which is the leading theory for the chronic "slow to switch chats" complaint AND possibly for the drops (a client-side stall cascading into a teardown).

These EOFs likely explain the "slow chat switching": every drop kills in-flight calls and subscriptions; a chat switch during the reconnect window loads nothing (the store's catch swallows the error).

## Approach

- After Joe next relaunches (needs the rebuilt daemon), let it run a while, then correlate: app-log `pipe reader stopped` lines vs daemon-log `client pid X disconnected/ended with error` lines. The pid tells you which process's connection died; the error variant tells you why.
- If drops continue with `disconnected` (clean, Ok-exit) for the APP's pid: the daemon saw the client close first, so hunt app-side (daemon_link teardown paths, PersistentClient drops - e.g. something recreating the client on transient RPC errors).
- If drops STOP after the concurrent-dispatch fix: the head-of-line blocking was the cause (a blocked connection tripping some timeout); note it and close.
- Check whether frequency correlates with heavy chat streaming or scheduled polls (drop timestamps were 2-20 min apart during active use).

## Update 2026-07-13 (v0.2.19, post concurrent-dispatch fix)

Recurrence confirmed - the concurrent-dispatch fix (`08d93445`) did NOT close this out. Same-day evidence:

- `daemon.log` / `Claude Conductor.log` show ~40 `pipe reader stopped: io error kind=UnexpectedEof: early eof` -> `daemon connection lost; respawning + reconnecting` events today, roughly every 1-3 min - same frequency as the 07-11 incident.
- New, worse symptom this time (Joe's report): fresh install/relaunch opened chats fine, one chat worked, then every other chat (including the one that had worked) started erroring; a subsequent app restart produced a full freeze (blank window, nothing rendering) instead of just a stall; required killing the process via Task Manager before a clean relaunch worked. This is an escalation beyond the "slow switching" symptom this todo was scoped around - the pipe drop may now be cascading into a startup-time deadlock/freeze, not just a runtime stall.
- Two full `claude-conductor started` events logged 6 min apart around the freeze window, consistent with Joe's kill+relaunch. No Rust panic logged for either restart (last panic in the log predates this, 2026-07-09, unrelated `lifecycle.rs:355`), so the freeze looks like a hang, not a caught crash - can't rely on panic logs alone to diagnose it.
- Joe says this specific pattern (works once, then breaks, then freezes on relaunch, resolved only by force-kill) has happened before, i.e. it's not a one-off.
- Error string shown to the user during the "chat won't open" phase wasn't pinned down exactly (Joe paraphrased "backend sending an error"); closest candidate in source is the stall-guard message in `src/views/sessions/active-session.ts` ("This chat isn't loading - the backend didn't respond."), unconfirmed.

Given the freeze is new and more severe than plain slow-switching, this todo may need to split: the original EOF/respawn diagnosis stays here, but if a next occurrence can be caught live (Joe leaves the app open + Task Manager visible instead of immediately killing it), capture whether the daemon or the GUI process is the one hung before killing anything - that pid-level distinction is missing from both incidents so far.

## Update 2026-07-13 (later same day) - correction + new gap + diagnostics added

Joe hit the "This chat isn't loading - the backend didn't respond." error again, same day, this time with NO app update, NO restart, and NO freeze - one chat (of several open) just silently stopped loading while the sidebar list kept working fine. Traced both the code path and the logs to correlate.

**Correction to the working theory:** the 8s stall-guard in `src/views/sessions/active-session.ts` (~line 308) does NOT wait on the daemon pipe. Traced its full awaited chain: `get_settings` (sync, in-memory `Mutex` clone, `src-tauri/src/ipc/settings.rs`), `renderer.attach()` (local JS only), and `load_history_page` (`src-tauri/src/ipc/chat/history.rs`, a `spawn_blocking` local filesystem read of the session's JSONL transcript). None of these touch `PersistentClient`/the named pipe. So the link this todo flagged as "unconfirmed" is now disconfirmed by the code as it stands - if this error fires, the stall is in the local settings/history-read chain (or an uncaught exception ahead of it), not a pipe EOF. The pipe drops DO kill an already-open chat's live turn stream (`daemon_bridge.rs`'s `ensure_attached` pump dies when the reader task clears `subs`), but that's a different symptom (an open chat going quiet mid-turn), not "won't load."

**Log correlation (both logs are UTC; local is UTC+2 in July - convert before comparing):**
- GUI log: `%LOCALAPPDATA%\com.sirbepy.claudeconductor\logs\Claude Conductor.log` (confirmed still the right path; truncates per app run).
- Daemon log: `%APPDATA%\claude-conductor\daemon.log` (Roaming, NOT Local as the original text implied - `%LOCALAPPDATA%\...\daemon.log` does not exist).
- Same EOF/respawn signature recurring every ~2-15 min all day (confirmed still happening at v0.2.19, post concurrent-dispatch fix - two occurrences bracketed the ~14:31 report, at 14:26:54 and 14:33:10 local).
- **New gap:** the daemon-side logging added earlier for this exact todo (`transport_windows.rs` connect/disconnect/error logs) logged ZERO lines - not even at info/warn level - anywhere near either EOF event, across the whole day. Confirmed the daemon's default log level is "info" (`env_logger` default filter, `cc_conductor_daemon.rs:8` / `lib.rs:74`), so this isn't a debug-level filtering artifact. Since `transport_common.rs:65-66` explicitly treats a read-side `UnexpectedEof`/`BrokenPipe` as a clean close and logs it at info via the `Ok(())` branch, the daemon should have logged a "disconnected" line for every client-observed EOF - and didn't. This means the daemon-side connection is not detecting these drops at all (not "detecting them silently" - genuinely not detecting them), which is a third case the original todo didn't consider (it only weighed "clean disconnect" vs "error", not "nothing logged, ever, on either side of a client-observed EOF"). Only 5 `client pid X disconnected` lines exist in the daemon log's entire multi-day history, and none of them time-align with any of today's ~15 client-observed EOF events.
- Working hypothesis this points toward (unconfirmed): either (a) the client's reader is seeing a spurious/local EOF unrelated to the daemon-side connection actually closing (Windows named-pipe quirk), possibly leaving a stale connection open daemon-side until it errors on a later write - which would connect to ai_todo 151's "pipe accept loop can wedge while HTTP health check stays green" scenario; or (b) a second, short-lived daemon process is transiently answering some connections and its log output isn't reliably landing in the same file (todo 151 territory again, though today's pattern - isolated blips, no rapid "duplicate-spawn race" log spam - doesn't match 151's 2+-hour crash-loop signature).

**Diagnostics added this session** (small, low-risk logging-only changes, no behavior change):
- `src-tauri/src/daemon/mod.rs`: daemon now logs its own pid at startup (`daemon: started, pid=N`) - directly tests the "second daemon process" hypothesis above; if this line ever appears twice close together in the log, that confirms a duplicate process was alive.
- `src-tauri/src/daemon_client/mod.rs`: added a per-connection generation counter (`PersistentClient::generation`, from a process-wide `AtomicU64`), logged on connect (`daemon: connected (generation N)`) and on reader-stop (`daemon pipe reader stopped (generation N): ...`) so a respawn cycle's log lines can be paired precisely instead of by timestamp proximity.
- `src-tauri/src/daemon_link.rs`: the "connection lost; respawning" log now includes the same generation number.
- `src/views/sessions/active-session.ts`: the stall-guard now `console.error`s the session id + a note that this is a local-chain stall, not a pipe issue, if it ever fires - so devtools (if open) immediately shows which session and rules out chasing the pipe again.

**Next occurrence checklist:** pull generation numbers from client-side logs and match against daemon startup-pid lines; if a "chat won't load" error recurs, check devtools console for the new stall-guard line (confirms/refutes it's actually this code path vs. something else entirely, e.g. a render exception). The todo's original acceptance item (artificially stall `loadStatuslineRows`, confirm ring -> error + Retry within ~8s) is still outstanding and unrelated to any of the above - it tests the guard mechanism itself, not the pipe-EOF question.

## Acceptance

- A named root cause for the EOFs, with the log-line pair proving it.
- Chat switching stays snappy during active turns (the head-of-line fix's user-visible effect).
- ALSO live-verify the chat-open stall guard from the same commit: with a healthy app, chats open with no visible flash; to see the error state, artificially stall (dev: make loadStatuslineRows never resolve) and confirm ring -> error + working Retry within ~8s.
