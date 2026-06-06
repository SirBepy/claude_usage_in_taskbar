---
id: 32
slug: when-done-engine-integration-test
title: Full task-level integration test for the when_done (sleep/shutdown) engine
status: pending
---

## Goal
Add a real integration test that drives the when_done protocol engine's phase machine end-to-end (watching -> closing -> countdown -> firing), so the orchestration glue is covered, not just the pure decision helpers.

## Context
ai_todos 28+29 shipped the sleep/shutdown-when-done engine (src-tauri/src/when_done.rs). Coverage today is the 4 extracted PURE fns (all_sessions_idle, waiting_on_ids, next_countdown, close_turn_complete) + the frontend menu. The async tokio task itself (run_engine) - which calls the daemon client for /close injection + prompt auto-resolve, emits Tauri events, and calls system_control::sleep_pc/shutdown_pc - has NO execution test. This was offered to Joe during the 2026-06-05 session and deferred; he can pick it up here.

## Approach
- Dependency-inject the two integration seams behind small traits (or closures): the daemon actions (send_message/list_pending_prompts/respond_*) and the terminal action (sleep_pc/shutdown_pc). Production wires the real impls; the test passes stubs that record calls instead of really sleeping the PC.
- Drive run_engine with a fake instances source (a Vec<Instance> the test mutates between ticks to simulate sessions going idle / a /close turn completing) and assert the phase progression + that the stub terminal action fires exactly once after the countdown, and that a cancel mid-countdown stops it.
- Keep it a scoped, daemon-safe test (`cargo test --lib when_done` style - RUN, not --no-run; never the full --lib which kills the dev daemon per [[project_cargo_test_kills_daemon]]).

## Acceptance
- An executing test drives watching -> closing -> countingDown -> firing with stubbed seams; asserts the terminal action stub fires once; asserts cancel short-circuits.
- The trait/closure refactor is behavior-preserving (production path unchanged); `cargo build` clean; the scoped test RUNS and passes.
