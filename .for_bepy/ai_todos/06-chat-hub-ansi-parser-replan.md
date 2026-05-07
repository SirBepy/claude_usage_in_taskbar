# Chat hub: replan ANSI parser path before resuming Phases 3-10

## Goal

Decide how to render claude CLI's interactive TUI output as a structured chat stream, then resume the chat-hub plan from Phase 3 onward. Phase 0 spike confirmed `--output-format=stream-json` only works with `--print` (one-shot non-interactive), so the original "Path A" is dead. Path B = parse the ANSI/TUI byte stream into ChatEvents.

## Context

Spec: `docs/superpowers/specs/2026-05-07-claude-chat-hub-design.md` (read the "Phase 0 result" section at the bottom).
Plan: `docs/superpowers/plans/2026-05-07-claude-chat-hub.md` (Task 3.3 explicitly says stop on Path B).

What's already landed on master (commits 2026-05-07/08):
- `b198f69` CHORE: portable-pty dep + `tests/spike_pty.rs` (the Phase 0 spike, `#[ignore]`d)
- `6d63089` REFACTOR: `hooks/instances` + `hooks/detector` -> `sessions/` module (`Registry`, `RegisterInput`, `InstanceKind` all live in `crate::sessions::*` now)
- `8da184d` FIX: `tests/export_types.rs` import update (Phase 1 follow-up)
- `bda54f3` FEAT: `InstanceKind::Interactive` variant + `crate::types::chat::{ChatEvent, ContentBlock, HistoryEntry}`. `ChatEvent::ToolUse.input` is `serde_json::Value` carrying `#[ts(type = "unknown")]`.

163 lib tests + all integration tests pass on master at `bda54f3`.

What's NOT yet landed (Phases 3-10): chat module (spawn / pty / parser / takeover / history), IPC commands, frontend Sessions+History views, image paste, detached windows, polish/docs.

Memory: `project_claude_cli_stream_json.md` documents the stream-json-only-with-print constraint so future sessions don't re-spike.

InstanceKind reality check: actual variants in repo are `Automated, External, Interactive` (NOT `Manual, Automated, Remote, Interactive` as the spec narrative implies). Anywhere the spec/plan says "Manual" mentally substitute "External" (or whatever the canonical name turns out to be after another read).

## Approach

**Update 2026-05-08:** Phase 0 extension spike found a fourth option that obsoletes options 1-3 below. See spec section "Phase 0 extension - Path C discovered". Path C = per-turn `claude -p --resume <id>` instead of persistent PTY. No ANSI parser needed; `-p` already emits clean stream-json. Two-turn continuity verified working (turn 1 saved a number, turn 2 with `--resume` recalled it). Parser shrinks from "weeks" to "thin line-delimited JSON deserializer". Phase 3 should be rewritten around Path C.

The original three options below are kept for context but should NOT be picked unless Path C is rejected for cost reasons (~$0.04-0.17 per user turn with caching, vs. included-in-subscription for interactive mode).

1. ~~**Inline ANSI parser as part of this plan.**~~ Replace plan Task 3.3 with a multi-step parser sub-plan: ANSI escape stripping, alternate-screen-buffer toggle handling, message-boundary detection from claude's box-drawing characters, streaming-token reassembly, user-prompt-echo distinction. Probably 5-8 sub-tasks. Substantial work; risk: claude's TUI format isn't documented and may shift across versions.

2. ~~**Separate, dedicated parser plan.**~~ Pause the chat-hub plan after Phase 2 (already done) and write a standalone parser plan first. Build the parser in isolation with a corpus of recorded claude TUI output as fixtures. Once it's solid, resume the main plan with parser Task 3.3 reduced to a thin "wire the parser in" task.

3. ~~**Cut scope to read-only history v1.**~~ Skip PTY ownership entirely. The Sessions sidebar lists Manual (External) sessions, clicking opens read-only chat replayed from `~/.claude/sessions/<pid>` JSONL. No spawn-from-app, no takeover, no composer, no image paste. Ships fast; doesn't solve Joe's terminal pain (he still types in his external terminal). Could be the v1 with PTY ownership tacked on later.

4. **Path C: per-turn `-p --resume`** (NEW, RECOMMENDED). Each user message spawns `claude -p --resume <session_id> --output-format=stream-json --verbose "<prompt>"` via plain `std::process::Command`. Stream stdout line-by-line as JSON events into the webview. claude exits when turn done. No persistent child between turns, no PTY, no ANSI parsing, no Windows PTY hang risk. Verified 2026-05-08; fixtures in `.for_bepy/spike_fixtures/`. Trade-off: per-turn cost (`~$0.04-0.17` observed) and ~1-2s cold start per turn.

Rejected: continuing with a stub parser. Joe's "don't silently drop user-visible content" rule precludes shipping a non-functional core.

## Acceptance

- Decision recorded (which of the three options) in the spec under a new "Phase 0 result -> resolution" subsection.
- If option 1 or 2: a new task list / plan file added that replaces or supplements `2026-05-07-claude-chat-hub.md`, with concrete sub-tasks. Test fixtures for the parser must include real captured TUI output from `claude` (record by piping into a file, not by hand-rolling expected bytes).
- If option 3: the spec's "Out of scope" section is rewritten to make read-only the v1 deliverable, and the plan's Phases 3+ are explicitly retired. Minimum viable Sessions sidebar still lands.
- No regression on the 163 lib tests already passing on master.
- Phase 2 types (`ChatEvent`, `ContentBlock`, `HistoryEntry`) survive any replan - they're shaped to fit either path.
