# Dedup channels: don't spawn a duplicate bridge for a project already running one

## Goal

`daemon::channels::start_channel` spawns a fresh `claude --remote-control` tree every time it's called, with no check for an existing live channel for the same project. Combined with `--continue` (every channel resumes the SAME session id), this causes:

1. **Bridge pile-up:** repeated Apply, or autostart-on-boot + a manual Apply, or daemon restarts (the previous channel is detached and survives, then a new one spawns), accumulate many `cmd.exe -> claude.exe -> node` trees - the exact "duplicate Claude desktop sidebar entries" the no-auto-restart rule was meant to avoid (see memory `project_remote_control_bridge_id.md`).
2. **Broken Automated correlation:** because all duplicates `--continue` the same session id (e.g. `609f826f`), the daemon's session->pid resolution (`resolve_session_meta`) returns *some* duplicate's pid, often not the one a given channel spawned. The pid-match (Phase 4 + the Windows claude-pid fix) then misses and the session shows External. Verified live 2026-05-20: with 5 duplicate ObsidianVault bridges, the hook resolved an orphan's pid; after killing all but one, it correctly tagged Automated.

## Context

- `src-tauri/src/daemon/channels.rs` - `start_channel(state, project_id)`. No "already running?" guard. `autostart_all` runs at daemon boot; the app's Apply also calls `start_channel` via RPC.
- `src-tauri/src/daemon/state.rs` - `state.channels: Arc<Manager>` tracks per-project `ChannelSnapshot { pid, claude_pid, status, hwnd }`.
- Daemon restart loses the in-memory manager but the detached bridges survive (that's survive-app-close working) -> the new daemon doesn't know about them -> respawns -> duplicates.

## Approach (two parts)

1. **In-session dedup:** at the top of `start_channel`, if `state.channels.snapshot(&project_id)` shows status `Starting`/`Running` with a live pid, return early (or return Ok without spawning). Prevents repeated Apply / autostart+Apply double-spawn within one daemon lifetime.
2. **Cross-restart adoption:** on daemon boot, before `autostart_all`, scan for existing `claude --remote-control` processes (sysinfo, command line contains `--remote-control` + the project's prefix/cwd) and adopt them into the manager (record pid + resolve claude_pid) instead of spawning new ones. Only spawn for autostart projects that have NO live bridge. This is the channels analogue of the spec's `orphan_adopt` idea (`docs/superpowers/specs/2026-05-19-detached-daemon-design.md`).

## Acceptance

- Pressing Apply twice (or autostart + Apply) for the same project does NOT create a second bridge tree.
- Restarting the daemon while a bridge is alive adopts the existing one rather than spawning a duplicate.
- With exactly one bridge per project, the session is tagged Automated reliably (already verified for the single-channel case).
- No regression to survive-app-close (the bridge still outlives the app/daemon).
