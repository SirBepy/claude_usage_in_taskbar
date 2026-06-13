# Let /supervised-run host this Tauri app (daemon breakaway)

## Goal

Make `cargo tauri dev` for this app run correctly under server_supervisor, so Claude can start the app for testing via `/supervised-run` instead of asking Joe to run `! cargo tauri dev`. Today the daemon gets trapped in an inherited Windows job when launched via the supervisor.

## Context

Verified live 2026-06-12 (see memory `project_supervised_run_incompatible`):

- The app's daemon spawner prefers `CREATE_BREAKAWAY_FROM_JOB` so the daemon outlives the app (`src-tauri/src/daemon/spawn_self.rs:43-51`). If denied (`ERROR_ACCESS_DENIED`) it retries WITHOUT breakaway and the daemon then shares the launcher's job lifetime.
- server_supervisor does NOT create a job object itself - it spawns supervised commands via `cmd /C <cmd>` with `CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW` (`server_supervisor/src-tauri/src/supervisor/proc.rs:343-347`). The job is INHERITED from the supervisor's own Tauri process; the supervised cmd + its descendants (our daemon) inherit it.
- Live proof: daemon.log logged `daemon spawn: CREATE_BREAKAWAY_FROM_JOB denied; retrying without breakaway`. The daemon still came up healthy (pipe listening, sessions adopted), but it's lifetime-coupled to the supervised process.
- Side effect / second bug: the supervised dev daemon seizes port 27182 (the daemon hook port), and its permission relay then errors every Bash/PowerShell from any OTHER claude session pointed at 27182 (`relay error: error sending request for url http://127.0.0.1:27182/permissions/request`). This wedged the adopting terminal session's tools this session.

## Approach

Primary fix (in **server_supervisor**, a separate repo at `C:\Users\tecno\Desktop\Projects\server_supervisor`): give the supervised spawn the `CREATE_BREAKAWAY_FROM_JOB` flag in `src-tauri/src/supervisor/proc.rs` (the spawn at ~line 343-350), using the SAME retry-without-breakaway fallback pattern as this app's `spawn_self.rs:43-51` (so it still works when there's no job / breakaway is disallowed). That lets the supervised cmd + the app's daemon escape the inherited job; `spawn_self.rs`'s first attempt then succeeds and the daemon detaches cleanly, exactly as in a normal terminal launch. The supervisor manages processes by PID + `taskkill /T` (not by job), so breakaway shouldn't break its stop/restart.

Then verify the port-27182 wedge is gone (or at least that stopping the supervised app cleanly frees 27182 and the real daemon returns).

Note: changing + rebuilding + restarting server_supervisor disrupts Joe's other supervised dev processes - coordinate the restart with him.

## Acceptance

- Launch this app via `/supervised-run` (`cargo tauri dev`); daemon.log shows NO `CREATE_BREAKAWAY_FROM_JOB denied` warning (breakaway succeeds).
- A NEW in-app chat starts and a turn runs to completion (chats actually work under supervised-run).
- Other concurrent claude sessions' Bash/PowerShell keep working (no 27182 relay wedge) while the supervised app runs.
- Stopping the supervised entry cleanly tears down the daemon without orphans.
