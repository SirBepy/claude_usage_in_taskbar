# remote_server.rs should be split into router/auth + handlers

## Goal
Extract the individual Axum endpoint handler functions from `remote_server.rs` into a new `remote_handlers.rs` so that each file stays under 400 lines and has a single clear concern.

## Context
`src-tauri/src/daemon/remote_server.rs` is 678 lines and mixes two concerns:
- Router construction, auth middleware, pairing file helpers, spawn entry point (lines 1–268)
- Individual endpoint handlers: `list_sessions`, `send_message`, `cancel_turn`, `rpc_dispatch`, `stream_ws`, `pump_events`, `transcribe_ws`, push subscription handlers, `pair_device`, `spa_fallback` (lines 269–558)

## Approach
Create `src-tauri/src/daemon/remote_handlers.rs`. Move all `async fn` handler functions (and their request/response structs) into it. Keep `spawn`, `build_router`, `auth_mw`, `sha256_hex`, `bearer_token`, and the pairing-file helpers in `remote_server.rs`. Add `mod remote_handlers;` + `use super::remote_handlers::*;` (or explicit imports) in `remote_server.rs`.

## Acceptance
- `remote_server.rs` < 300 lines, `remote_handlers.rs` < 450 lines
- `cargo build --manifest-path src-tauri/Cargo.toml` passes
- All existing remote-server tests still pass
