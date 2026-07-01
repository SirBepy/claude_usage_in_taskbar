# Duplicate-spawn guard only checks HTTP port, not the named pipe - caused a 2-hour crash loop

## Goal

Stop the daemon respawn logic from getting permanently stuck when the named pipe is dead but the HTTP hooks port is still alive.

## Context

`src-tauri/src/daemon/mod.rs` (~around where "a healthy daemon already serves port 27182; exiting (duplicate-spawn race)" is logged): a newly-spawned daemon process checks ONLY the HTTP hooks server on `127.0.0.1:27182` to decide whether a healthy daemon already exists, and exits immediately if so. It does not check whether the *named pipe* (`src-tauri/src/daemon/transport_windows.rs` `accept_loop`) - the actual IPC channel `PersistentClient` needs - is still accepting connections.

Found via `%APPDATA%\claude-conductor\daemon.log`: from 2026-06-29 07:43:21Z to at least 09:53:07Z (386+ occurrences of the "duplicate-spawn race" log line, roughly every 20s for 2+ hours), the app's `ensure_daemon()` (`src-tauri/src/daemon_client/mod.rs:401-426`) kept failing to connect via the named pipe, spawning a new daemon each cycle, which immediately exited because the OLD daemon's HTTP port still answered healthy - even though that old daemon's pipe was apparently not accepting connections. The loop only broke at 09:53:27Z when a daemon finally started clean (no "already serves" message), implying the old stuck daemon eventually died on its own for an unrelated reason. Until that happened, the app was fully unable to talk to any daemon for over 2 hours.

## Approach

Change the duplicate-spawn health check to also attempt a named-pipe connect (or otherwise verify the pipe is accepting), not just the HTTP port. If the pipe check fails while the HTTP port succeeds, the new daemon should NOT immediately exit - it should either take over the pipe (if it can bind it) or signal the old process to shut down via the HTTP port's RPC (there's already a `shutdown_daemon` RPC per `src-tauri/src/daemon_client/mod.rs:218-220`) before retrying. Needs care to avoid a new race where two daemons both think the other is unhealthy.

## Acceptance

- Reproduce (or reason through) a scenario where the named pipe accept loop stalls while the HTTP hooks server stays up, and confirm the app recovers within a bounded time instead of looping forever.
- No regression to the existing legitimate duplicate-spawn race handling (two app instances launching simultaneously should still result in only one daemon).
