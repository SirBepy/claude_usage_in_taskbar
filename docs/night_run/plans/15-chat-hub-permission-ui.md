# Phase 11 - Chat-hub permission + AskUserQuestion UI

## Context

The chat hub spawns `claude -p --resume <id>` per turn (see `src-tauri/src/chat/runner.rs`). The spawn currently passes no `--permission-mode` and no `--permission-prompt-tool`, so default mode blocks Edit / Write / Bash and the inner agent stalls. Same for `AskUserQuestion`. The user has no way to approve or answer from the chat pane; the only workaround is killing the chat session and resuming in a terminal claude.

Build a permission-prompt + question relay so the chat pane can approve, deny, or answer mid-turn without breaking the per-turn `-p` model.

The full design lives at `docs/superpowers/specs/2026-05-09-chat-hub-permission-ui.md` - read it first; this file is the build instructions.

## Stack

- Single Rust binary doubles as the Tauri app and (via `--mcp-permission` CLI flag) a stdio MCP server.
- HTTP coordination piggybacks on the existing hooks server (`src-tauri/src/hooks/server.rs`).
- Tauri events + IPC for UI <-> backend.
- No new third-party crates if avoidable. Implement MCP JSON-RPC 2.0 by hand over stdio (lines of JSON, no framing — one JSON object per line per the MCP stdio transport).

## Tasks

### Task 1 - Hooks server: pending-request map + endpoints

Edit `src-tauri/src/hooks/server.rs`.

Add a shared state field `pending: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>` (use `tokio::sync::oneshot` and `serde_json::Value`).

Add four endpoints:

- `POST /permissions/request` — body `{id: String, tool_name: String, input: Value}`. Insert oneshot tx into `pending`, emit Tauri event `permission-requested` carrying `{id, tool_name, input}`, await oneshot rx with a 5-minute timeout. On timeout, return JSON `{behavior: "deny", message: "user did not respond in time"}`. On success, return whatever the IPC sent.
- `POST /permissions/respond` — body `{id, behavior: "allow"|"deny", updated_input?: Value}`. Pop oneshot from map, send the value through.
- `POST /questions/request` — body `{id, questions: Value}`. Same shape; emits `question-requested` event.
- `POST /questions/respond` — body `{id, answers: Value}`.

All four endpoints share the same `pending` map (request ids are globally unique UUIDs).

Ports: the hooks server already binds a port (read it from existing code). Persist it to `<app-data>/hooks_port.txt` so the MCP-server subprocess can find it.

### Task 2 - MCP server binary mode

Edit `src-tauri/src/main.rs`. At the very top of `main`, before any Tauri setup:

```rust
let args: Vec<String> = std::env::args().collect();
if args.iter().any(|a| a == "--mcp-permission") {
    return crate::mcp::server::run_stdio();
}
```

Create `src-tauri/src/mcp/mod.rs` with `pub mod server; pub mod client;`. Wire the module into `src-tauri/src/lib.rs`.

Create `src-tauri/src/mcp/server.rs`. Implement a stdio MCP server that:

1. On stdin, reads JSON-RPC requests one-per-line.
2. Responds to `initialize` with server info `{name: "cc_companion", version: "0.1.0"}` and capabilities `{tools: {}}`.
3. Responds to `tools/list` with two tools, names `approval_prompt` and `ask_user_question`. inputSchema as in the spec.
4. Responds to `tools/call` for `approval_prompt`:
   - Generate UUID v4.
   - HTTP POST to `http://localhost:<port>/permissions/request` with `{id, tool_name, input}` (read tool_name + input from request params).
   - Wait for response (default 5min, server side enforces).
   - Return tool_result content `[{type: "text", text: <JSON of {behavior, updatedInput?}>}]`.
5. Same for `ask_user_question` against `/questions/request`.
6. Reads port from `<app-data>/hooks_port.txt`. On read failure, return MCP error.

Create `src-tauri/src/mcp/client.rs` for the HTTP client (use existing `reqwest` dep). Blocking client is fine — this binary is not the Tauri app, no async runtime needed unless we want one.

### Task 3 - Runner.rs: spawn claude with permission-prompt-tool

Edit `src-tauri/src/chat/runner.rs::run_turn`.

Before spawning claude:

1. Resolve current exe path via `std::env::current_exe()`.
2. Write a temporary `.mcp.json` to `<app-data>/mcp/<turn-uuid>.json` with content:
   ```json
   {
     "mcpServers": {
       "cc_companion": {
         "command": "<exe path>",
         "args": ["--mcp-permission"]
       }
     }
   }
   ```
3. Add CLI args:
   ```
   --permission-prompt-tool mcp__cc_companion__approval_prompt
   --mcp-config <path to tmp .mcp.json>
   ```
4. After `child.wait()`, delete the tmp file.

Stream-json output already pumps through ParserContext - no parser changes needed for permission tool calls (the inner claude calls our MCP tool, the result flows through normally).

### Task 4 - IPC commands

Edit `src-tauri/src/ipc/chat.rs`. Add:

```rust
#[tauri::command]
pub async fn respond_permission(
    id: String,
    behavior: String,         // "allow" | "deny"
    updated_input: Option<Value>,
    state: State<'_, AppState>,
) -> Result<(), String> { ... }

#[tauri::command]
pub async fn respond_question(
    id: String,
    answers: Value,
    state: State<'_, AppState>,
) -> Result<(), String> { ... }
```

Both look up the oneshot in the hooks server's pending map, send the value, drop the entry.

Register both in `src-tauri/src/lib.rs::run` invoke handlers list. Add both to `src-tauri/capabilities/default.json`.

### Task 5 - Permission modal UI

Create `src/views/sessions/permission-modal.ts`. Module-level singleton listener installed at sessions-view mount. Listens for Tauri event `permission-requested`. When fired, render a modal overlay anchored to the active chat pane:

- Title: `Permission requested`
- Tool: `<tool_name>`
- Input: pretty-printed JSON in a `<pre>`
- Buttons: `[Allow]` (primary), `[Deny]` (secondary). Buttons fire `respond_permission` IPC with the request id.
- ESC = Deny.

Reuse the modal-host pattern already present in sessions.ts (`ensureModalHost`).

Style under `src/views/sessions/sessions.css` as `.permission-modal`. Match existing modal-card styling.

### Task 6 - AskUserQuestion inline rendering

Edit `src/shared/chat/chat-renderer.ts`. In `renderMessage`'s tool_use case, branch on `m.tool === "AskUserQuestion"`:

- Parse `m.input` as `{questions: [{question, options: [{label, description}]}]}` (per AskUserQuestion schema). Defensively type-check; fall back to existing JSON-pre rendering on shape mismatch.
- Render: question text, then a `<button>` per option labeled with `option.label` and tooltip `option.description`.
- On click: fire IPC `respond_question` with `{id: <tool_use_id>, answers: {<question>: <selected_label>}}`. Disable all buttons after first click; selected button stays highlighted; "Submitted" badge appears.

Style under `src/shared/chat/chat.css`.

The tool_use_id used as the `respond_question` id must match the id the MCP server passed when posting to `/questions/request`. Pass it through as a hidden field in `m.input` (the MCP server includes it when relaying).

### Task 7 - Detached windows

Verify the modal + AskUserQuestion render in detached windows too. The Tauri event is global; both attached and detached panes will receive it. Suppress duplicate modals: only the window currently selecting the request's session should render. Use `state.selectedId === <event session_id>` to gate. The MCP server must include the session_id in the request payload — read it from the running runner via the chat runner's per-turn slot.

### Task 8 - Tests

- `src-tauri/src/mcp/server.rs`: unit test the JSON-RPC dispatch (initialize, tools/list, tools/call routing). Mock the HTTP client.
- `src-tauri/src/hooks/server.rs`: integration test the request/response roundtrip via the existing test harness; assert the oneshot channel cleans up on respond and on timeout.
- `src/shared/chat/chat-renderer.test.ts` (vitest): assert AskUserQuestion tool_use renders option buttons; assert click fires IPC with correct shape.

### Task 9 - CLAUDE.md update

Add a `## Chat hub permissions` section to root `CLAUDE.md` describing:

- Permission-prompt-tool flow (claude -p -> MCP server -> hooks HTTP -> UI -> IPC -> back).
- AskUserQuestion same pipeline.
- Where the tmp .mcp.json lives.
- How to debug (`<app-data>/hooks_port.txt`, MCP server stderr).

Update the file table at the top to list `mcp/server.rs`, `mcp/client.rs`, `views/sessions/permission-modal.ts`.

## Acceptance

- Run `cargo tauri dev`. Open Sessions, start a new chat, ask claude to edit any file. Modal appears with tool_name=Edit + the input. Click Allow. Edit succeeds.
- Click Deny on the next request. Edit fails cleanly, turn continues with claude reporting the denial.
- Trigger AskUserQuestion (e.g. ask claude to invoke a slash command that uses it). Buttons render. Click. Answer reaches the inner turn. Conversation continues.
- Close UI mid-prompt. Wait 5 minutes. Inner claude receives a `deny` (`message: "user did not respond in time"`) and continues.
- All cargo tests pass: `cargo test --manifest-path src-tauri/Cargo.toml`.
- vitest passes: `pnpm vitest run` (or whichever command the repo uses; see `project_tauri_tests.md` memory).

## Out of scope

- Persistent allowlists across sessions (follow-up).
- `acceptEdits` / `bypassPermissions` toggles (not exposed; the modal is the only path).
- Audit log of approvals (could be added later as a journal file under `<app-data>/`).
