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

## Acceptance

- A named root cause for the EOFs, with the log-line pair proving it.
- Chat switching stays snappy during active turns (the head-of-line fix's user-visible effect).
- ALSO live-verify the chat-open stall guard from the same commit: with a healthy app, chats open with no visible flash; to see the error state, artificially stall (dev: make loadStatuslineRows never resolve) and confirm ring -> error + working Retry within ~8s.
