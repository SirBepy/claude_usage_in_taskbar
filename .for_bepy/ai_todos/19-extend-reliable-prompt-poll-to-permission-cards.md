# Extend the reliable prompt poll to permission cards

## Context

The AskUserQuestion fix (former ai_todo 16, resolved + e2e-verified) moved **question** prompts off the lossy daemon->app notifier broadcast onto a reliable poll: the daemon records open prompts in `DaemonState.pending_prompts` and the app polls `list_pending_prompts` (RPC) and emits each prompt's Tauri event (`spawn_pending_prompt_poll` in `daemon_link.rs`). Root cause was that the `notifier` broadcast silently drops frames under pipe backpressure (`subscribe_global`'s `Err(Lagged(_)) => continue`).

**Permission cards (Bash/Edit/etc.) still ride that same lossy broadcast** - `daemon_link.rs` still handles the `permission_request` arm via the broadcast, and `on_permission_request` only publishes (doesn't record a pending prompt). So permission cards can flakily fail to appear the same way AskUserQuestion did.

## Fix (mirror the question path)

1. `hooks_server/permission.rs` `on_permission_request`: build the payload, then `ctx.state.add_prompt(&body.id, "permission-requested", json!({"id", "tool_name", "input", "session_id"})).await` at the start; `ctx.state.remove_prompt(&body.id).await` on both the resolve and timeout paths (same shape as `on_question_request`).
2. `daemon_link.rs`: remove the `"permission_request"` arm from `handle_daemon_notification` (the poll's generic emit already handles any stored prompt's event, so it will deliver `permission-requested` once recorded - no code change needed in the poll).
3. Verify: a real Bash/Edit permission prompt in the in-app chat reliably renders the allow/deny card. Could add a billed e2e mirroring `question-card-live.e2e.js`.

## Priority

Low unless permission cards are observed dropping. The poll infra already exists; this is ~the same 2-edit change the question path got.
