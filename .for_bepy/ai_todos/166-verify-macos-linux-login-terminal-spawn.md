# Verify macOS/Linux login-terminal spawn strings

**Type:** task

## Goal
Confirm the reworked `spawn_login_terminal` shell strings actually run on macOS and Linux (banner echoes, `CLAUDE_CONFIG_DIR` export, `claude` launch).

## Context
Commit 568178fa reworked `src-tauri/src/accounts/login_step.rs` `imp::spawn` for all three OSes (added a banner line naming the account). Only the Windows path was live-probed (wt.exe -> cmd /K, env propagation verified on Joe's machine 2026-07-08). The macOS variant nests the banner in single quotes inside an AppleScript double-quoted `do script` string; the Linux variant embeds it in a `bash -c` string - both are quote-nesting-sensitive and untested. Joe has a Mac reachable over SSH (see the `/ios-run` skill for connection mechanics); Linux has no test box, so a dry syntax check (run the generated bash string with `claude` swapped for `env | grep CLAUDE_CONFIG_DIR`) is acceptable there.

## Approach
On the Mac: build or copy the generated osascript string (replicate `imp::spawn`'s format with a temp dir and display name "personal"), run it, confirm Terminal opens with the banner and `echo $CLAUDE_CONFIG_DIR` shows the temp dir. For Linux: extract the `run` string and execute it under `bash -c` locally (any WSL/container works) with `claude` stubbed. Fix any quoting breakage found, mirroring the Windows no-embedded-double-quotes rule.

## Acceptance
Both non-Windows spawn strings demonstrated to set CLAUDE_CONFIG_DIR and reach the `claude` invocation (or stub) without shell parse errors; fixes (if any) committed with a regression note in login_step.rs.
