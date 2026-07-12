# Status pipeline redesign (2026-07-12)

Context log for future sessions. If chat statuses (done/question/waiting/working) misbehave again, read this first - it records what was tried, what was rejected and why, and where each fix lives.

## The problem

Sidebar status per chat came ONLY from the AI self-reporting a `<cc-status:..>` text marker at the end of every response. Two failure classes:

1. **Misjudgment** - the AI says `done` while background subagents it dispatched are still running (or vice versa). Self-report can't fix this: the AI genuinely believes it.
2. **Malformed tags** - the AI writes `<cc-status>done</cc-status>` (XML form) or a hybrid, the daemon's rigid `rfind` on the literal colon form missed it, status went stale.

Joe's original idea (an MCP status API the AI calls, with retry-on-error) was rated 4/10 and evolved through a 6-round /iterate-it. Key rejections (do NOT re-propose):

- **MCP status tool as primary** - self-report can't fix self-misjudgment; MCP tool schema costs tokens every turn; extra round-trip per turn.
- **Deriving `working` from process-alive** - the chat process is long-lived across turns (`daemon/lifecycle.rs::spawn_session`); the real turn boundary is the `result` stream-json line.
- **TodoWrite tasks-file overlay with TTL** (`<config_dir>/tasks/<session_id>/*.json`) - was the plan (P7 Lane B) until the live test revealed the Stop payload carries `background_tasks` directly, which is strictly better ground truth. The tasks-file idea is superseded, not wrong.
- **Blocking the Stop hook on incomplete todos** - stale TodoWrite entries would loop forever.
- **Expiry/TTL heuristics for terminal state** - redundant once marker delivery is enforced.

## The live test (ran 2026-07-12, C:\tmp\stopprobe, since deleted)

Procedure: scratch dir, `--settings` file registering a Stop hook (PowerShell script that blocks unless `stop_hook_active`), `claude --print "..." --output-format stream-json --verbose`. Findings, all verified against the installed CLI:

- Stop payload carries `last_assistant_message`, `stop_hook_active`, and **`background_tasks` (array of live background tasks)** - the ground-truth channel earlier rounds concluded didn't exist. Also `session_crons`, `permission_mode`, `effort`.
- Returning `{"decision":"block","reason":"..."}` from a Stop hook forces the model to continue and address the reason. It re-emitted the marker correctly on retry.
- `stop_hook_active: true` arrives on the post-block Stop - honoring it caps enforcement at one retry per turn.
- **Exactly one `result` line fires**, at the true end, carrying the FINAL (post-retry, marker-bearing) text. The daemon's turn-boundary invariant is safe under blocking. `num_turns` goes 1 -> 2.
- Gotcha: hook commands run through sh even on Windows - backslashes in unquoted command paths get eaten (`C:\tmp\x.ps1` -> `C:tmpx.ps1`). Use forward slashes in hook commands.
- Gotcha: project-level `.claude/settings.json` hooks do NOT load for an untrusted dir in print mode; `--settings` works.

## What shipped (three lanes)

**Lane A - tolerant marker parsing** (`src-tauri/src/chat/parser.rs::detect_awaiting`): now accepts colon form, XML form, hybrid colon-open/XML-close, mixed case, stray whitespace - mirroring what the frontend's `chat-classifiers.ts` already tolerated. A quoted instruction (`<cc-status:done|question|...>`) never matches: label must be followed by `>` or `<`. Unit tests alongside.

**Lane B - ground-truth override for misjudgment**:
- `hooks_server/stop.rs::on_stop` records `background_tasks.len()` into a registry side map (`Registry::set_background_tasks`, `sessions/registry.rs`) - daemon-hosted sessions only (`state.sessions.contains_key` gate keeps Joe's terminal sessions out).
- The pump's result-line handler (`daemon/lifecycle.rs`, next to `set_awaiting_if_gen`) overrides a `done`/missing marker to `working` when the count is non-zero. Ordering is guaranteed: the CLI holds the `result` line until the Stop hook responds, so the count is always fresh.
- Self-correcting: a finishing background task re-invokes the session; that turn's Stop refreshes the count to zero.

**Lane C - marker enforcement (Joe's retry idea, harness-enforced)**:
- `on_stop` blocks a daemon-hosted turn whose `last_assistant_message` has no parseable marker, with a reason echoing the system-prompt syntax. Guards: never when `stop_hook_active`; never when `last_assistant_message` is absent (older CLI -> enforcement silently off, no block loop); never for non-daemon sessions.
- `hooks/installer.rs::curl_command` hardened to `curl -s --connect-timeout 2 --max-time 4 ... || exit 0` (matches what was already live in `~/.claude/settings.json`, which had drifted ahead of the repo) and `CURRENT_INSTALL_VERSION` bumped 3 -> 4 so existing installs rewrite on next launch.

Unchanged, still standing: `question` also arrives via the pending-prompt relay (PreToolUse AUQ hook); `cc-progress`/`cc-title` parsing untouched (title already tolerant; progress is a numeric grammar with different failure shape).

## Verification state

- `cargo build` + `cargo test --lib` (637 tests) green on 2026-07-12.
- The blocking mechanism itself was live-verified standalone (probe above), but the END-TO-END path (daemon's on_stop returning block to a real conductor chat) needs the rebuilt daemon running: **restart the app/daemon, start a chat, and watch a turn that omits or malforms the marker get one retry**. Until then the old daemon binary is still serving.

## If statuses misbehave again, check in this order

1. Is the marker in the final text? (`detect_awaiting` unit tests cover the forms; a NEW malformed variant means extending it AND `chat-classifiers.ts`.)
2. Did the Stop hook fire and did it block? Daemon log: `hook /hooks/stop: blocking <sid> - no status marker`.
3. Is `background_tasks` in the Stop payload for the CLI version in use? If the CLI renamed/dropped it, Lane B silently degrades to marker-only (by design - absent field = count 0).
4. Is the installed global hook the v4 shape (timeouts + `|| exit 0`)? `~/.claude/settings.json`, all profiles symlink to it.
