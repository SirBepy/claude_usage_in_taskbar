# Split when_done.rs into protocol / engine / surface modules

## Goal

Break `src-tauri/src/when_done.rs` (1052 lines) into three focused files at its natural seams.

## Context

`when_done.rs` mixes three distinct concerns in 1052 lines:

1. **Protocol types + state** (lines ~1-93): `TerminalAction`, `ProtocolPhase`, `ProtocolState`, `WhenDoneInner` — pure data structures with no app coupling.
2. **Engine + helpers** (lines ~94-563): `run_engine_with_deps`, `EngineDeps`, and 12 private helper functions (`instance_is_idle`, `auto_resolve_prompts`, `inject_close`, etc.) — the actual state-machine logic.
3. **Public IPC surface** (lines ~564-624): `arm_when_done`, `cancel_when_done`, `get_when_done_state` — the three Tauri command entry points.
4. **Tests** (lines ~625-1052): 427 lines of unit tests that test the engine through `EngineDeps`.

The test suite alone is 427 lines; splitting them alongside the engine module keeps test files near the code they cover.

## Approach

Convert `when_done.rs` into a module directory:

```
src-tauri/src/when_done/
  mod.rs          # re-exports arm_when_done, cancel_when_done, get_when_done_state
  protocol.rs     # TerminalAction, ProtocolPhase, ProtocolState, WhenDoneInner
  engine.rs       # run_engine, run_engine_with_deps, EngineDeps, all private helpers
  engine_tests.rs # move #[cfg(test)] mod tests from when_done.rs here (#[path] or inline)
```

`mod.rs` is thin — it just imports from protocol + engine and re-exports the three public async fns. No logic moves to mod.rs.

Update `src-tauri/src/lib.rs` (or wherever `mod when_done` is declared) — no change needed if the module path stays `when_done`.

## Acceptance

- `cargo build --manifest-path src-tauri/Cargo.toml` clean.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib when_done` — all existing tests pass.
- No public API changes (same three exported fns, same types).
- Each split file is under 400 lines.
