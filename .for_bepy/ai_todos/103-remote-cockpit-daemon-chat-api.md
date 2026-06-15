---
id: 103
slug: remote-cockpit-daemon-chat-api
title: Remote cockpit Phase 1 - daemon chat-core extraction + tailnet-bound authed HTTP/WS server
status: parked
---

## Why parked

SECURITY-CRITICAL. This endpoint pipe-drives `claude` with Bash/Edit/Read tools, so a mis-secured server = remote code execution on the dev machine. Autopilot will not stand up an internet/tailnet-reachable RCE-capable endpoint unattended - it needs Joe's review and his Tailscale setup (BEPY_TODOS Urgent / blocks this). Phase 0a (the transport seam) is already shipped (commit 864b10d). Full design: `docs/superpowers/specs/2026-06-15-remote-phone-cockpit-design.md` (gitignored, local).

## Scope (Phase 0b + Phase 1 together)

1. **Extract chat ops into plain core functions** (`list_sessions`, `send_message`, `cancel_turn`, `get_transcript`, `start_session`, ...). Today these live inside Tauri commands + the named-pipe daemon RPC. Make the Tauri commands thin wrappers over the core fns so the new HTTP handlers call the *same* functions (one implementation, two entry points). Bundling 0b here (not done standalone) because extracting with no second caller is pointless until this server exists.
2. **New dedicated authed axum server for the phone**, separate from the localhost hooks server (`daemon/hooks_server/`) - different security posture, keep it one auditable module.
   - **Fail-closed network bind:** bind ONLY to the Tailscale interface IP (discover at startup). Never `0.0.0.0`, never public, not even LAN. If Tailscale is absent/down, the server does NOT start.
   - **REST for actions** (list/send/cancel/start/transcript) mapping to the core fns.
   - **WebSocket for streaming:** subscribe to the existing per-session broadcast (`broadcast::publish` / subscribe in `daemon/`) and forward events. Also forward session-list / `instances_changed` so a remote sidebar stays live.
   - **Per-request bearer-token auth middleware** on every REST + WS request (tokens minted in Phase 2). No token -> 401. Defense-in-depth on top of the tailnet.
3. **Concurrency:** rely on the existing busy/turn serialization + held-messages queue so desktop + phone driving one session can't corrupt the single `claude` stdin; both subscribers mirror live.

## Status 2026-06-15: SHIPPED + live-verified

- Server (commit cb4bbf6) + allowlisted `POST /api/rpc` (commit b46e4fa) are in and LIVE-VERIFIED by Joe via curl: `/api/health` -> ok; no token -> 401 (fail-closed); valid token -> real session list; allowlist 403s non-listed methods (unit-tested; the live 403 curl just needs PowerShell-safe quoting `--data-raw '{"method":"..."}'`).
- `SAFE_METHODS` allowlist (8): list_instances, list_pending_prompts, start_session, send_message, cancel_turn, respond_permission, respond_question, set_session_effort.
- Phase 0b (extract chat-core fns + make Tauri commands thin wrappers) was NOT needed: `/api/rpc` reuses the existing daemon RPC router directly (cloned in run_daemon_main), which already is the shared logic layer.
- Remaining for full parity (later): widen the allowlist as the client needs more methods; a transcript-on-open endpoint (history is app-side today, daemon has no transcript loader - the WS live stream covers in-flight turns only).

## Acceptance

- Core fns exist; Tauri chat commands are thin wrappers over them (behavior unchanged); `cargo build` clean, existing daemon tests green (scoped, never the full `--lib` that kills the dev daemon - see memory `project_cargo_test_kills_daemon`).
- The authed server starts ONLY when bound to a real tailnet interface and refuses all unauthed requests (test the 401 path + the fail-closed no-Tailscale path).
- A WS client receives a session's live events off the broadcast.
- Security review by Joe before this is exposed to a real phone.
