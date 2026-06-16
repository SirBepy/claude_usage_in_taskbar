---
id: 102
slug: remote-control-chats-architecture-fork
title: Restore phone remote-control for in-app chats (architecture fork - needs Joe's decision)
status: decided
---

## Decision (Joe, 2026-06-16)
**Path B - the app speaks claude's remote-control bridge wire protocol**, so ONE interactive session is driven by both the app and the phone (true convergence, the deferred "Phase 5b"). Keep the entire daemon epic (stdin stream-json driving, cancel-via-control_request, partial streaming, held-messages, AUQ relay) AND restore phone control. Joe accepts this is a real project: reverse-engineer / implement claude's remote-control protocol client plus an outbound channel. NOT A/C/D. Start with a spike to reverse-engineer the bridge wire protocol (capture a live interactive --remote-control session's traffic) before committing to the full client.

## Why this is parked, not done

Joe (2026-06-14, /autopilot): "remote control is selected by default yet none of these
chats become remote-control chats... it used to work before the daemon epic, just make it
work." Investigated live and it is a **hard Claude-CLI constraint, not a bug** - no flag fix
exists. Restoring it is an architecture decision with high, hard-to-reverse blast radius, so
autopilot parked it instead of guessing.

## Root cause (proven, not theorized)

The daemon spawns each chat as `claude -p --input-format=stream-json --output-format=stream-json
--include-partial-messages ... --remote-control` (see `daemon/claude_config.rs::base_claude_args`).
`--remote-control` is **silently ignored** there:

- `claude --help`: `--remote-control [name]` = "Start an **interactive** session with Remote
  Control enabled"; `--input-format` / `--output-format` / `--include-partial-messages` are each
  documented as "only works with **--print**".
- Empirical: `claude --output-format=stream-json` WITHOUT explicit `-p` errors
  `"When using --print, --output-format=stream-json requires --verbose"` - i.e. stream-json output
  **forces print mode**. Print mode never opens a remote-control bridge.
- On disk: `~/.claude/sessions/<pid>.json` for app chats shows `entrypoint:"sdk-cli"` and **no**
  `bridgeSessionId`. Only interactive `entrypoint:"cli"` sessions (the channel/Plan-C spawn in
  `channels/spawn.rs`, e.g. the running Obsidian `--remote-control` session) get a `bridgeSessionId`.
  A fresh app chat (pid 35028) had `--remote-control` literally on its command line yet still no bridge.

"Worked before the daemon epic" = pre-daemon chats ran as **interactive** `--remote-control`
sessions (entrypoint cli, real bridge, phone-controllable). The daemon epic switched chats to
print-mode stream-json to get programmatic stdin turn-driving + partial streaming + cancel via
control_request; the bridge was the casualty. **The two modes are mutually exclusive in one
`claude` process.**

Also note: the app's `is_remote` display flag is wired ONLY to the channel path
(`hooks_server/lifecycle.rs` matches the hook pid against `state.channels`), never to a per-chat
`--remote-control` - so even if a bridge existed, a chat would not render as remote without extra wiring.

## The fork (Joe picks one)

- **A. Revert in-app chats to interactive `--remote-control` spawns** (like `channels/spawn.rs`).
  Gains: real phone bridge. Loses: the daemon's stdin stream-json driving, cancel-via-control_request,
  partial-message streaming, held-messages, the AUQ relay design - i.e. most of the Phase 5-7 daemon
  epic. App would have to drive/watch turns via the transcript + bridge protocol, not stdin.
- **B. App speaks the remote-control bridge wire protocol** so one interactive session is driven by
  BOTH the app and the phone (true convergence, the deferred "Phase 5b"). Gains: keep rich in-app
  control AND phone control. Cost: large - reverse-engineer/implement claude's remote-control
  protocol client; this is the deferred `jsonl_tail` phone-convergence work plus an outbound channel.
- **C. Dual process**: keep the print-mode daemon driver AND spawn a parallel interactive
  `--remote-control --resume <same-id>` bridge. High risk: two claude processes on one session id
  (resume lock, double transcript writes, divergent state). Likely broken; not recommended.
- **D. Accept the limitation**: stop shipping the no-op `--remote-control` flag + `defaultRemoteControl`
  setting on chats (they mislead), and document that phone remote-control is the **channels/automation**
  path only. Smallest, most honest, but removes the feature Joe asked to restore - so NOT done
  unilaterally.

Recommended sequence: Joe decides A vs B vs D. If "make it work" truly means phone-controllable
chats, B is the only option that keeps the daemon epic, but it is a real project. D is the honest
stopgap if B is too costly right now.

## Acceptance (whichever path)

- An in-app chat is controllable from the phone (its claude session file carries a `bridgeSessionId`),
  verified live, OR the no-op flag/setting is removed + documented (path D).
- No regression to in-app chat send / cancel / streaming.
- `cargo build --manifest-path src-tauri/Cargo.toml` + `pnpm tsc --noEmit` clean.
