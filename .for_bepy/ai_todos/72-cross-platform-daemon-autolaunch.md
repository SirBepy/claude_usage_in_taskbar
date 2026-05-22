# Cross-platform daemon auto-launch (mac/Linux)

## Goal

Extend the Phase 6 daemon auto-launch (Windows-only) to macOS and Linux so the
daemon reliably exists on those platforms too.

## Context

Phase 6 (`docs/superpowers/specs/2026-05-21-daemon-phase-6-autolaunch-design.md`)
ships Windows-only because:
- The daemon transport is a Windows named pipe (`daemon/transport_windows.rs`); no
  Unix-domain-socket transport exists yet.
- The detached spawn reuses Windows `CreateProcessW` flags (`channels/spawn.rs`).

Joe is the sole user on Win11, so this is deferred, not dropped.

## Approach

1. Add a Unix-domain-socket transport (`daemon/transport_unix.rs`) mirroring the
   named-pipe one; pick the socket path under the app data dir.
2. Detached spawn on Unix: `setsid()` / own process group in `pre_exec` (mirrors the
   macOS channel spawn already in `channels/`), so `<exe> --daemon` outlives the app.
3. Wire `ensure_daemon` + the connection watcher to the per-OS transport + spawn.
4. Decide autostart-on-login if wanted (LaunchAgent on mac, systemd-user/XDG autostart
   on Linux) - or rely on app-launch spawn like Windows.

## Acceptance

- App on mac/Linux spawns + connects to the daemon the same way Windows does.
- Survive-app-close + reconnect verified on at least one non-Windows platform.
