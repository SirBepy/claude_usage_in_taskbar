# AUQ cc_companion MCP path: add retry on connection failure

## Goal

Add retry logic to the cc_companion MCP server's HTTP call to the daemon hook server (`/questions/request` or `/permissions/request`) so a transient connection failure (port briefly unavailable, daemon restart between turns) doesn't silently drop an AskUserQuestion.

## Context

ai_todo 116 (intermittent AUQ non-render) was closed with a partial fix: `--retry 2 --retry-delay 1` was added to the curl hook command that covers the **PreToolUse hook path** (`/hooks/ask-question`). The companion also has a second path: the **MCP cc_companion server** (`write_mcp_config` in `claude_config.rs` launches the app exe with `--mcp-permission`). This MCP server handles the custom `ask_user_question` tool and may also route the builtin `AskUserQuestion` in some configurations. Its HTTP calls to the daemon use reqwest (or similar); if the daemon is transiently unreachable, the call fails without retry and the question is never registered in `state.pending_prompts` - so the reliable poll can't surface it either.

The todo #116 error `relay error: error sending request for url (http://127.0.0.1:27182/permissions/request)` is the MCP path failing. The curl path is now mitigated; this path is not.

## Approach

1. Find where the MCP permission server (`--mcp-permission` mode) makes its HTTP calls to the daemon (search for `permissions/request` or `questions/request` in the Rust source - likely in `src-tauri/src/mcp/` or similar).
2. Wrap those calls with retry logic: 2 retries, 1s delay, on connection errors only (not on 4xx responses).
3. If using reqwest, consider a retry middleware or a manual `for` loop with `tokio::time::sleep`.

## Acceptance

- The cc_companion MCP server retries a failed `/permissions/request` or `/questions/request` call at least twice before giving up.
- A transient connection refusal (daemon restarting between turns) no longer silently drops the question.
- Existing happy-path (daemon available) behavior is unchanged.
