# Reconnect a chat's MCP server via resume-respawn

## Goal

Let the dev reconnect a daemon-hosted chat session's MCP server(s) from the
Companion chat UI, instead of having no in-app equivalent of interactive
Claude Code's `/mcp` reconnect. Build the list and the reconnect action
together; do NOT ship a view-only server list (the dev confirmed a passive
list has never been useful - status is only worth showing if it's actionable).

Deferred deliberately: build this when a broken MCP actually blocks a chat,
not speculatively.

## Context

How MCP is wired into chats (verified this session):

- The daemon spawns one long-lived `claude -p --input-format=stream-json` per
  session (`src-tauri/src/daemon/lifecycle.rs::spawn_session`) and passes
  `--mcp-config <temp>.json` (written by `daemon/claude_config.rs::write_mcp_config`).
- That temp file declares only the `cc_companion` permission-relay server, but
  `--strict-mcp-config` is NOT passed, so the dev's real MCP servers (from
  `~/.claude.json` / project `.mcp.json`) are MERGED in. So real servers
  (figma, playwright, etc.) do live in these chats.
- MCP servers connect ONCE, at process spawn. The interactive `/mcp` reconnect
  is a TUI feature; there is no confirmed headless stream-json control-protocol
  message to reconnect a single server live (the control protocol does
  `interrupt` / `set_permission_mode`, which is how `cancel_turn` works, but
  not MCP reconnect). Do not chase a surgical single-server live reconnect
  without first verifying the control protocol supports it - assume it does not.

## Approach

Reconnect = respawn that session's `claude` process with `--resume`. A fresh
spawn re-reads the merged MCP config and re-handshakes EVERY server. Reuse the
daemon's existing resume path (`base_claude_args(Some(resume_id), ...)`).

Coarse by design and that's acceptable: reconnects all of the session's
servers, only between turns (not mid-turn). No protocol reverse-engineering.

Build:
1. Daemon-side: an action that kills the session's current process and
   resume-respawns it (resume the same session id). Guard against running
   mid-turn.
2. IPC command (new `#[command]`, wired in `generate_handler`; custom commands
   need no `capabilities/default.json` entry per project memory).
3. Chat UI affordance: surface the session's MCP servers + connection status;
   a broken one gets a "Reconnect" button that calls the IPC -> daemon respawn.

## Acceptance

- A chat showing a failed MCP server exposes a Reconnect control.
- Triggering it respawns the session via `--resume`; the server re-handshakes
  and works in the next turn, with chat history intact.
- No view-only-only variant shipped; the list exists only as the surface for
  the reconnect action.
- Reconnect is blocked or queued cleanly if a turn is in flight (never kills
  mid-turn).
