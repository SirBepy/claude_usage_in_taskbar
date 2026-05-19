# Tomorrow's AI Prompt - Continue Daemon Pivot (Phase 3)

The `claude_usage_in_taskbar` project is mid-pivot to a long-running helper daemon (`cc-companion-daemon`). Phases 1 + 2 shipped to master on 2026-05-19 (and were pushed). Phase 3 is next.

## What to do

1. **Read the spec first:** `docs/superpowers/specs/2026-05-19-detached-daemon-design.md`. It is the source of truth for the whole 7-phase plan. (Gitignored, lives on disk.)

2. **Skim the existing phase plans** at `docs/superpowers/plans/2026-05-19-daemon-phase-1-scaffolding.md` and `docs/superpowers/plans/2026-05-19-daemon-phase-2-session-lifecycle.md` to match their shape when writing Phase 3.

3. **Write the Phase 3 plan** via the `superpowers:writing-plans` skill. Save to `docs/superpowers/plans/2026-05-19-daemon-phase-3-hooks-registry-mcp-move.md`.

4. **Execute** via `superpowers:subagent-driven-development` (Joe's preferred pattern, established in this same multi-phase pivot).

## Phase 3 scope (from the spec)

Move the hook server + sessions registry + MCP server lifetime into the daemon. The daemon already owns chat sessions (Phase 2); Phase 3 makes it own the supporting infrastructure too:

- `src-tauri/src/hooks/server.rs` (Axum app for `/hooks/session-start`, `/hooks/session-end`, `/permissions/request|respond`, `/questions/request|respond`, `/notify`, `/refresh`, `/quit`) moves wholesale into the daemon process. Same endpoints, same port-file at `<app-data>/hooks_port.txt`, daemon writes it now.
- `src-tauri/src/sessions/registry.rs` (`Instance` map keyed by session_id) moves from app `AppState` into daemon state. The app keeps a cached projection refreshed via the new `list_sessions` RPC + `instances_changed` notification.
- `src-tauri/src/mcp/server.rs` stays unchanged code-wise but its lifetime changes: one MCP child per session (already done in Phase 2 Task 11), no app-side ownership.
- Hooks installer (`src-tauri/src/hooks/installer.rs` merging into `~/.claude/settings.json`) stays in the app for the first-run UX gate. Daemon does not write to `~/.claude/settings.json` autonomously.

## Execution pattern Joe picked

- **Branch:** create a fresh `daemon-phase-3` feature branch off master before any code lands.
- **Sub-skill:** subagent-driven-development, uninterrupted (no checkpoints between tasks). Continuous execution, main agent commits between tasks via `/commit`.
- **Subagent commit rule:** include `**ABSOLUTE RULE: Do NOT run \`git commit\`. Stage with \`git add\` only.**` near the TOP of every dispatched subagent prompt. One Phase 2 implementer ignored a less-emphatic instruction; explicit phrasing prevents it.
- **Pre-approve standard well-known deps** if a task needs one (e.g. env_logger, dashmap, axum is already a dep). Skip the implementer's ask-gate round-trip if the crate is obviously safe.
- **Per-task commit message format:** `FEAT: <description> (Phase 3 Task N)` — match the suffix from Phase 1 + 2.
- **Final step per phase:** invoke `superpowers:finishing-a-development-branch`, fast-forward merge to master, delete branch immediately (per the auto-delete-merged-branches memory rule).

## Gotchas you don't need to re-discover

- `ChatEvent` is INTERNALLY tagged via `#[serde(tag = "type", rename_all = "snake_case")]`. Don't write code that assumes external tagging (object key as variant name).
- `claude` CLI does NOT honor a `{"type":"interrupt"}` stdin sentinel (Spike A, verified 2026-05-19). Cancel-turn uses kill_tree + respawn with `--resume`.
- Windows Task Scheduler logon trigger inherits user env adequately for claude auth (Spike B, verified 2026-05-19). macOS/Linux NOT spiked yet - defer to Phase 6.
- `chat::runner::write_mcp_config` is `pub` and is reused by `daemon::lifecycle::spawn_session`.
- Pre-existing flake in `notifications::rules::character_resolver_returns_synthetic_rule_for_valid_character_with_slot_file` (passes in isolation, fails in parallel runs). Unrelated to daemon. Don't chase it.
- `cargo test --lib daemon::` is the scoped verification command for daemon-module tests (avoids the pre-existing flake).
- The hooks-port-discovery file (`<app-data>/hooks_port.txt`) is consumed by claude itself per Joe's global config (every claude spawn auto-bridges via remote-control). When moving the hook server into the daemon, the port file must continue to be written exactly as before so existing/external claude instances keep finding it.

## Out-of-scope reminders

- Phase 3 does NOT touch macOS / Linux transports (still Windows-only). Phase 6 adds Unix socket + LaunchAgent + systemd.
- Phase 3 does NOT rewrite Tauri commands as RPC clients (that's Phase 5).
- Phase 3 does NOT add autostart install / crash recovery (Phase 6).
- Phase 3 does NOT remove the Phase-1 hook server from the app process YET if external claudes still need a port to talk to during a transitional window. The exact swap-over mechanism is a Phase 3 design call - flag it during planning.

## State at handoff

- Branch: `master`. 27 commits ahead of `origin/master` ... no wait, that was BEFORE the push. After pushing (via `/commit pushnbump`) master is at the published version and origin/master matches.
- Daemon binary: `src-tauri/target/debug/cc-companion-daemon.exe` builds, listens on `\\.\pipe\cc-companion-daemon-<USERNAME>`, handshakes, dispatches `health` + 6 session-lifecycle RPCs.
- 31 daemon module unit tests pass. Phase 1 smoke + Phase 2 e2e (manual, `#[ignore]`'d) pass.
- No remaining staged changes, no orphan daemon processes.
