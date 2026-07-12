# Daemon needs diagnostics for why it exited and why a session snapshot loaded empty

**Type:** task

## Goal
Add two small log lines so a future "interactive-sessions.json emptied out"
incident (like the one investigated in this session, see
`src-tauri/src/sessions/persistence.rs`'s `save_refuses_to_wipe_a_populated_snapshot`
regression test) is forensically diagnosable instead of a dead end.

## Context
On 2026-07-10, `interactive-sessions.json` went from 8 restorable Interactive
chat sessions to 0 between two daemon restarts (`daemon.log`: "restored 8
interactive session(s) from snapshot" at 11:19:35Z, no "restored N" line at
the 12:12:21Z restart). Root-caused as an external kill of the daemon process
during active dev/rebuild work (no graceful-shutdown log line, no PANIC —
the signature of an external `taskkill`/rebuild-triggered restart rather than
a crash), NOT a reachable code race (a scheduler-race theory was proposed and
disproven by an independent subagent check: `schedule::spawn`'s tick loop
sleeps 30s before its first tick, and the RPC accept loop binds after the
registry restore anyway, so no save can race the restore).

The investigation was slower than it needed to be because:
1. Nothing logs *why* the daemon process is exiting (graceful shutdown vs.
   external kill vs. panic already covered). Can't distinguish "someone
   rebuilt and killed it" from other causes without external evidence.
2. `load_snapshot` in `src-tauri/src/sessions/persistence.rs` collapses
   "file doesn't exist" and "file exists but is empty/corrupt" into the same
   silent `Vec::new()` return (only the JSON-parse-failure branch logs a
   warning and preserves a `.broken-<ts>` backup; a file that legitimately
   parses to `[]` is indistinguishable from a missing file).

A `save_snapshot` guard against wiping a populated snapshot was added this
session (commit `b019c904`) as the actual data-loss backstop; this todo is
the complementary diagnostics half that makes the *next* anomaly traceable
instead of requiring hours of log archaeology.

## Approach
- In `load_snapshot` (`src-tauri/src/sessions/persistence.rs`), log at
  `debug` or `info` level whether the file was missing vs. present-but-empty
  vs. present-with-N-entries, so a restart's "restored 0" (or silence) can be
  read back against this line.
- On graceful daemon shutdown (wherever `ctrl-c`/shutdown-notified is
  currently logged in `src-tauri/src/daemon/mod.rs`'s `run_daemon_main`),
  confirm that path already logs something distinguishable — if so, no code
  change needed there, just note in the PR/commit that an *unlogged* daemon
  disappearance between two "daemon listening on..." lines should now be
  read as "externally killed, not a graceful exit."

## Acceptance
`cargo build --manifest-path src-tauri/Cargo.toml` passes. A future incident
where the snapshot file is empty/missing on daemon start can be diagnosed
from `daemon.log` alone (missing-file vs. empty-file vs. parse-error is
visible), without needing to reconstruct timeline from indirect evidence.
