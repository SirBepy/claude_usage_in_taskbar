# Chat-hub cost rejection followups

## Goal

Decide what to do with the 35-commit chat-hub feature shipped to master that bills metered API per turn, when Joe's hard constraint is subscription-only / no per-turn cost ever.

## Context

Master is at commit `2317ba5` after a 14-plan night-run that built the chat hub via "Path C" (per-turn `claude -p --resume <session_id> --output-format=stream-json --verbose --include-partial-messages "<prompt>"` invocations via `std::process::Command`). The feature works end-to-end:

- Sessions view (`src/views/sessions/sessions.ts`) - sidebar of live sessions, +New + Send buttons, Composer with image paste, Take Over for External (Manual) sessions, Detach to separate window.
- History view (`src/views/history/history.ts`) - read-only past-session browser. **This piece is FREE - just reads `~/.claude/sessions/*.jsonl` files. No API calls.**
- Backend: `chat::runner::run_turn`, `chat::parser::parse_line`, `chat::takeover::takeover`, `chat::history::replay`, ten `ipc::chat::*` commands.
- Polish: app-quit cleanup of in-flight runner children, 30-day GC of pasted-image files, doc rewrites in CLAUDE.md + README.md.

Phase 0 spike (`src-tauri/tests/spike_pty.rs`, `#[ignore]`'d) confirmed (a) `--output-format=stream-json` only works with `--print` (Path A dead) and (b) `claude -p --resume <id>` preserves session continuity (Path C works technically). Captured spike fixtures live at `.for_bepy/spike_fixtures/` (probably want to delete - contains session ids + hook outputs).

**The rejection.** Joe explicitly said: "I don't want anything to cost me / we don't even want this product if it'll cost me / it will never cost me / we don't want it to ever cost me." Path C bills metered API at observed cost of $0.04-0.17 per turn. Subscription ($20/mo Pro) covers interactive `claude` only, NOT `-p` mode.

See:
- `docs/superpowers/specs/2026-05-07-claude-chat-hub-design.md` - spec, especially "Phase 0 result" + "Phase 0 extension - Path C discovered" sections at bottom.
- `docs/night_run/log.md` - 14 ticks recorded, attempts per phase noted.
- `~/.claude/projects/.../memory/feedback_billing_gates.md` - new memory rule about surfacing billing model up front.
- `~/.claude/projects/.../memory/project_claude_cli_stream_json.md` - updated with the unviable verdict for Path C.

## Approach

Five candidate paths, in rough order of cost-to-benefit:

**A. Full revert.** `git reset --hard 06760a3` (just before the night-run plan files were committed) + `git push --force origin master`. Loses all 35 commits including the genuinely-free History view + parser + types. Keeps Phase 1 (sessions/ rename) and Phase 2 (Interactive variant + types) which are useful regardless. Cleanest mental reset. Force-push is destructive on master but the work is rejected anyway.

**B. Path B (ANSI parser).** Keep everything, swap out `chat/runner.rs` to spawn plain `claude` (no `-p`) under a PTY (portable-pty already in deps from Phase 0) and parse the TUI output. Subscription-covered. Costs:
- Weeks of parser work (alternate-screen-buffer, cursor positioning, box-drawing message-boundary detection, streaming-token reassembly, user-prompt-echo distinction).
- Brittle: claude's TUI format is undocumented and may shift across CLI versions.
- Already on master via Phase 0 spike's `stream_json_interactive_works` test which proved the TUI output is hostile (test ran 60+ seconds with no parseable output before being killed).
- Windows PTY hang risks the spike already surfaced.

**C. Cut to History-only.** Keep History view (`src/views/history/history.ts`) and its IPC commands `load_history` + `list_history`. Strip the Sessions view's Send/+New paths. Delete cost-bearing `ipc::chat::*` commands: `start_session`, `send_message`, `cancel_turn`, `paste_image`, `takeover_manual`, `detach_window`, `reattach_window`, `cancel_all_inflight_turns`, `gc_attachments`. Delete `chat/runner.rs`, `chat/takeover.rs`. Sessions view becomes read-only "live session monitor + transcript replay." Useful but doesn't replace the dream of a chat hub with sending.

**D. Pivot to Claude Agent SDK.** Build the chat against the SDK in a Rust harness. SDK billing model is the same metered route - same problem unless Joe has an Anthropic API plan that bundles `-p` (he doesn't appear to).

**E. Cancel feature entirely.** Drop the chat hub. Joe's original pain points (multi-window vscode, terminal-rendering quirks, image paste) remain unsolved. Could pivot to a vscode plugin instead. Or accept the workflow as-is.

Joe's lean during the brainstorm session was for the chat hub specifically; he's not (yet) shopping for alternatives. Best to confirm he hasn't given up on the feature entirely before picking a direction.

## Acceptance

- A direction is picked (A/B/C/D/E or hybrid) and the rationale is captured in this todo (or a follow-up).
- If A: `git reset --hard 06760a3` executed; force push to origin/master; CLAUDE.md and README.md re-reflect the pre-chat-hub identity. Verify `cargo test -p claude-usage-tauri` is clean (180+ tests should still pass on the pre-night-run state since Phase 1 + Phase 2 land before the reset point).
- If B: Phase 0 spike test re-purposed as a TUI capture harness; an ANSI parser plan is brainstormed (use the `superpowers:brainstorming` skill, not inline). Parser ships as a separate plan, then `chat/runner.rs` is rewritten to spawn plain `claude` under a PTY.
- If C: cost-bearing IPC commands removed from `lib.rs` invoke_handler, `src-tauri/src/chat/runner.rs` and `src-tauri/src/chat/takeover.rs` deleted, `src/views/sessions/sessions.ts` rewritten to render a read-only sidebar + transcript-replay pane. CLAUDE.md and README.md updated to reflect the scoped-down identity.
- Spike fixtures at `.for_bepy/spike_fixtures/` reviewed for personal data; deleted or `.gitignore`'d.
- The new chat that picks this up uses the prompt below (paste-ready) so it doesn't have to re-derive the situation.

## Paste-ready new-chat prompt

```
I built a "chat hub" feature for the claude_usage_in_taskbar app
(Tauri 2 tray app for Claude Code) using Path C - per-turn
`claude -p --resume <id>` invocations. Problem: -p is METERED API
billing, not subscription. ~$0.04-0.17 per turn. I refuse to
build any feature that costs me. Help me decide what to do.

Hard constraint: must use my Pro subscription tokens, never bill
the metered API key. Period.

Background:
- claude --help: --output-format=stream-json + --input-format only
  work with --print (= one-shot metered)
- Phase 0 spike (in src-tauri/tests/spike_pty.rs, #[ignore]'d) proves
  this. Path A (stream-json in interactive PTY) is dead.
- My night-run shipped 35 commits implementing Path C. ALL on master,
  all pushed.

What landed (cost-bearing - has to go or stay disabled):
- chat/runner.rs (spawns claude -p)
- chat/takeover.rs (kill external + spawn -p --resume)
- ipc/chat.rs commands: start_session, send_message, cancel_turn,
  paste_image, takeover_manual, detach_window, reattach_window,
  cancel_all_inflight_turns, gc_attachments
- src/views/sessions/sessions.ts (full orchestration)
- markdown-it + shiki npm deps
- Phase 10 polish (quit cleanup, GC, doc rewrites)

What landed (free / useful regardless):
- sessions/ module rename (was hooks/instances.rs) - pure refactor
- types/chat.rs ChatEvent/ContentBlock/HistoryEntry
- chat/parser.rs (parses JSON, free)
- chat/history.rs replay (READS JSONL, no API calls)
- src/views/history/history.ts (read-only past-session browser, free)
- sessions/registry busy field + helpers

Key files to read:
- docs/superpowers/specs/2026-05-07-claude-chat-hub-design.md
  (spec, especially "Phase 0 result" + "Phase 0 extension - Path C
  discovered" sections at bottom)
- docs/night_run/log.md (run history)
- CLAUDE.md (rewritten with Path C; needs reverting depending on
  decision)
- README.md (rewritten; same)
- .for_bepy/COMMENTS.md (notes from earlier sessions)
- .for_bepy/ai_todos/07-chat-hub-cost-rejection-followups.md
  (THIS file - has the full breakdown)
- ~/.claude/projects/C--Users-tecno-Desktop-Projects-claude-usage-
  in-taskbar/memory/MEMORY.md (project memories - including
  feedback_billing_gates.md and project_claude_cli_stream_json.md)

Available paths forward:

A. Full revert. git reset --hard 06760a3 (just before night-run
   plan files were committed) + force push. Loses 35 commits but
   keeps Phase 1+2 refactor + spike. Clean slate to think.

B. Path B (ANSI parser). Keep everything, swap out runner.rs to
   parse TUI output of plain `claude` (subscription-covered).
   Weeks of parser work, brittle (no docs on TUI format), but
   solves the cost problem.

C. Cut to History-only. Keep History view (free), strip Sessions
   view's Send/+New, delete chat IPC commands except load_history
   + list_history. App becomes "live session monitor + past
   transcript viewer" with no chat sending.

D. Pivot to Claude Agent SDK. Build the chat against the SDK in
   a Rust harness. SDK billing model: same metered. So same problem
   unless you have an Anthropic API plan that bundles -p.

E. Pivot away entirely. VSCode extension? Read-only-overlay-character
   thing? Cancel chat hub feature.

Help me think this through. Don't write code. Just brainstorm
the tradeoffs and recommend a direction, then ask before doing
anything. Use the brainstorming skill.

Brevity over grammar. Drop articles. Caveman mode preferred.
```
