# Harden app<->daemon startup so the tray reliably comes up

## Goal
Kill the flaky-startup ritual ("clear something and run it again, eventually it works"). After a kill/auto-update, relaunching the app should reliably show the tray icon and establish a working daemon RPC connection on the first try.

## Context
Observed 2026-06-04: after the 0.1.68 auto-update, the app (PID 1660) and daemon (PID 16640) both launched at the EXACT same second (12:18:49). Chat send/open and close-persist were all dead, while the HTTP hook server (separate channel) kept working - classic symptom of the app↔daemon PIPE RPC never establishing. The daemon log showed ZERO `session ... live` lines since that restart despite being alive. A clean kill of both + relaunching the app FIRST (so it spawns its own daemon in order) fixed it immediately.

Two suspected contributors:
1. Startup race: if the app tries to connect before the daemon's named pipe (`\\.\pipe\cc-companion-daemon-tecno`) is listening, the initial connect fails and isn't retried robustly. See `src-tauri/src/daemon_link.rs` (the connect/`subscribe_global` loop has backoff on RECONNECT, but verify the FIRST connect attempt also retries rather than giving up).
2. Stale launch state: leftover `daemon.lock` / `hooks_port.txt` in `%APPDATA%\claude-usage-tauri\`, or the `tauri-plugin-single-instance` guard, can make a relaunch silently no-op so the tray never appears.

There is also a recurring `transport_windows: frame size 2065852772 exceeds 16777216` warning (0x7B22 = ASCII `{"`), i.e. something writes raw newline-delimited JSON into the length-prefixed pipe. It predates this session and the daemon survives it, but confirm it isn't the app's own client mis-framing on a bad connect.

## Approach
- In `daemon_link.rs`: ensure the INITIAL connect retries with bounded backoff until the pipe is ready (don't rely on the daemon being up first). Add a health/handshake check after connect so a half-open pipe is detected and retried, not treated as connected.
- Consider having the app spawn-and-wait-for-ready its daemon (poll the health RPC) before declaring connected, instead of assuming readiness.
- On launch, detect+clear stale single-instance / lock state so a relaunch after a hard kill doesn't no-op (the tray must always appear).
- Add a visible "daemon disconnected / reconnecting" state in the UI so a dead pipe is obvious instead of silently hanging chat forever.

## Acceptance
- Kill both processes, relaunch the app: tray appears and a new chat works on the first try, repeatably (no "clear and rerun").
- Simulate daemon-not-ready (launch app a beat before daemon): app still connects via retry rather than wedging.
- `cargo build --manifest-path src-tauri/Cargo.toml` clean; any daemon_link logic covered by a unit/e2e test where feasible.
