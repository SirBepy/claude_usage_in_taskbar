# Tomorrow's AI Prompt - Continue Daemon Pivot (Phase 3 Tail + Phase 4)

The `claude_usage_in_taskbar` project is mid-pivot to `cc-companion-daemon`. Phases 1+2 shipped to master. **Phase 3 is 12 of 14 tasks done on branch `daemon-phase-3`** (not yet merged). Tasks 13 + 14 + manual verify + merge remain.

## State at handoff (2026-05-20)

- Branch: `daemon-phase-3` (12 commits ahead of master). Local only - not pushed.
- All 12 commits compile clean (`cargo check --manifest-path src-tauri/Cargo.toml --lib` passes with 3 expected-unused warnings: `Duration`/`Emitter`/`Manager` in stubbed `sessions/detector.rs::run`, plus a pre-existing `CommandExt` warning in `daemon/lifecycle.rs`).
- Tauri app was running during the session, so `cargo build --bin claude-usage-tauri` was NOT exercised. Subagents used `cargo check` throughout. Before merging, do a full `cargo build` once the app is closed to catch any release-only / linker errors.
- Daemon binary builds: `cargo build --bin cc-companion-daemon` last verified Task 11.
- Daemon manual smoke (`http://127.0.0.1:27182/health`) was NOT exercised because the app owned port 27182. Step in Task 14 (or pre-merge) does this once the app is closed.

## What's left in Phase 3

### Task 13: app-side respond_permission / respond_question IPC

**Already done inline by Task 12.** `src-tauri/src/ipc/chat/lifecycle.rs:330` (respond_permission) and `lifecycle.rs:359` (respond_question) forward via `state.daemon_client.lock().await...respond_permission/question`. Returns `Err("daemon client not connected")` if the daemon-client slot isn't populated yet at first call. Verify-only step: read those two functions to confirm they look right; if so, skip the formal Task 13 commit.

### Task 14: end-to-end integration test

Create `src-tauri/tests/daemon_hooks_e2e.rs` per the plan (full code already in `docs/superpowers/plans/2026-05-19-daemon-phase-3-hooks-registry-mcp-move.md`, Task 14). The test:
1. Builds + spawns the daemon.
2. Connects a PersistentClient, pushes default Settings, subscribes globally.
3. POSTs a synthetic `/hooks/session-start` to 127.0.0.1:27182.
4. Asserts `instances_changed` notification arrives within 2s with the new session_id.
5. POSTs `/hooks/session-end`, asserts second `instances_changed`.
6. Kills daemon.

**Prerequisite:** kill the running Tauri app first (it owns 27182). PowerShell: `Stop-Process -Name claude-usage-tauri -Force` (verify name with `Get-Process | Where-Object { $_.ProcessName -like '*claude*' }` first).

`reqwest` is already a workspace dep so the test can use it directly. Mark the test `#[ignore]` so CI never runs it; invoke manually with `cargo test --manifest-path src-tauri/Cargo.toml --test daemon_hooks_e2e -- --ignored --nocapture`.

### Pre-merge manual checklist

- [ ] Kill Tauri app
- [ ] `cargo build --manifest-path src-tauri/Cargo.toml --bin cc-companion-daemon`
- [ ] `cargo build --manifest-path src-tauri/Cargo.toml --bin claude-usage-tauri`
- [ ] Run daemon in one window: `cargo run --manifest-path src-tauri/Cargo.toml --bin cc-companion-daemon`
- [ ] Confirm log shows `daemon hook server listening on 127.0.0.1:27182` AND `daemon listening on \\.\pipe\cc-companion-daemon-<USER>`
- [ ] `Invoke-WebRequest http://127.0.0.1:27182/health` returns `{"daemon":"ok"}`
- [ ] `Get-Content $env:APPDATA\claude-usage-tauri\hooks_port.txt` returns `27182`
- [ ] Ctrl-C daemon
- [ ] Launch Tauri app: `cargo tauri dev` (from `src-tauri/`)
- [ ] Daemon auto-running in another window OR Tauri app spawns it (app currently expects daemon to exist; if it doesn't connect, this is a known fallback gap — Phase 6 adds autostart). For first-time smoke, run daemon manually in parallel.
- [ ] Confirm app boots, settings load, dashboard renders
- [ ] Open Settings -> trigger a state change so app pushes settings to daemon
- [ ] Start an external `claude` in any project dir; confirm Running Instances sidebar shows the new instance within ~5s (via daemon's SessionStart + `instances_changed` notif)
- [ ] In that `claude`, ask it to do an Edit (triggers permission flow); confirm app modal appears, click Allow, confirm `claude` proceeds
- [ ] Quit external claude, confirm sidebar updates
- [ ] Quit Tauri app
- [ ] Run Task 14 integration test

### Then merge

```
git checkout master
git merge --ff-only daemon-phase-3
git branch -d daemon-phase-3
```

Then `/commit pushnbump` to publish.

## Known follow-ups for Phase 5 (not Phase 3 scope; track separately)

Task 12's subagent left 9 `// TODO: Phase 5 forwards via daemon RPC` stubs where the legacy app-side chat IPC mutated the in-process Registry:

- `src-tauri/src/ipc/chat/builtins.rs:42` - clear_session
- `src-tauri/src/ipc/chat/lifecycle.rs:~123` - open_session_in_terminal
- `src-tauri/src/ipc/chat/lifecycle.rs:~252` - takeover_manual (returns Err pending Phase 5)
- `src-tauri/src/ipc/chat/run.rs:~68, ~123, ~148, ~210, ~266, ~324` - run_session_turn variants + set_session_effort + register_historical_session

These mean the legacy "app spawns claude -p per turn" path (still wired in run.rs etc.) no longer updates busy/model/effort tracking. The chat-hub UI may visibly show stale state for sessions that go through the legacy path between Phase 3 ship and Phase 5 ship. Acceptable transitional per spec. Phase 5's job is to rewrite all those Tauri commands as RPC calls to the daemon (which already owns the registry).

## Phase 3 architectural decisions locked (for reference)

1. Hard port-swap (no proxy): app stops binding 27182, daemon takes over.
2. Settings stays app-authoritative; daemon holds push-refreshed cache. `project_created` notification flows daemon -> app on new cwd; `upsert_project_with_id_for_cwd` helper persists with the daemon's chosen id.
3. Channels-tagged-Automated regression on hook path until Phase 4 (channels still live in app for Phase 3). Note appended to `.for_bepy/COMMENTS.md`.
4. Detector reconcile loop moves with registry; app-side `sessions::detector::run` stubbed to `std::future::pending()`.
5. Permission/question pending map fully moves to daemon. App responders forward via RPC.
6. Hook installer stays in app (first-run modal owns the UX).

## File-shape orientation

New files (committed on `daemon-phase-3`):
- `src-tauri/src/daemon/notifier.rs` - daemon-wide broadcast (Task 1)
- `src-tauri/src/daemon/settings_cache.rs` - push-refreshed Settings (Task 2)
- `src-tauri/src/daemon/state.rs` - DaemonState container (Task 3)
- `src-tauri/src/daemon/hooks_server.rs` - axum hook server (Tasks 5-9)
- `src-tauri/src/daemon/detector_task.rs` - 5s reconcile loop (Task 10)

Modified:
- `src-tauri/src/daemon/methods.rs` - +register_notifier, +register_settings, +register_responders
- `src-tauri/src/daemon/mod.rs` - module declarations
- `src-tauri/src/daemon/rpc.rs` - `global_sub` slot on ConnectionContext
- `src-tauri/src/daemon_client/mod.rs` - +push_settings, +respond_permission, +respond_question, +subscribe_global
- `src-tauri/src/sessions/detector.rs` - extracted `reconcile_once(&Registry) -> bool`
- `src-tauri/src/settings/store.rs` - +upsert_project_with_id_for_cwd
- `src-tauri/src/bin/cc_companion_daemon.rs` - Phase 3 wiring (Task 11)
- `src-tauri/src/state.rs` - cached_instances + daemon_client (no more instances/pending)
- `src-tauri/src/lib.rs` - handle_daemon_notification + startup subscribe
- `src-tauri/src/hooks.rs` (was hooks/mod.rs) - removed `pub mod server;`
- `src-tauri/src/ipc/chat/{builtins,lifecycle,run}.rs` - registry mutation stubs (Phase 5 TODOs)
- `src-tauri/src/ipc/{project_groups,projects}.rs` - cached_instances reads

Deleted:
- `src-tauri/src/hooks/server.rs` (moved into daemon/hooks_server.rs)

## Gotchas you don't need to re-discover (Phase 3)

- `cargo check` is enough for type validation while the app is running (writes nothing to `target/debug/*.exe`); `cargo build` errors on locked exe.
- `sessions::detector::reconcile_once` owns its strike state via a process-wide `OnceLock<Mutex<HashMap>>`. Safe because only one of daemon/app runs the detector per process post-Task-12; if you ever spawn both in the same process, strikes would interleave.
- `Project` in this codebase is called `ProjectConfig` and has 7 fields (id, path, name, avatar, automation, created_at, last_active_at). `upsert_project_with_id_for_cwd` copies all 7 from the canonical fn.
- `SettingsCache::upsert_project_for_cwd` takes a snapshot AFTER cache mutation so the Registry's internal `upsert_project_for_cwd` finds the same id (shim-mutex pattern in `hooks_server::on_session_start`).
- The reader in `PersistentClient::connect` routes notifications without a session_id to the empty-string slot. Don't break the `.unwrap_or("")` fallback there or `subscribe_global` stops receiving.
- `tokens::TokenRecord.live` is `Option<bool>` and `.merged_subagents` is `Option<Vec<String>>` — set both to `None` in the daemon's `/refresh` handler.
- `skill_usage` types are called `SkillUsageEvent` (not `SkillEvent`).
- `crate::settings::load(&Path) -> Settings` is infallible (no Result wrap); returns default on parse failure.
