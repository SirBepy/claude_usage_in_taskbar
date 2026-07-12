# Run the scheduling e2e suites and live-verify the feature

**Type:** task

## Goal

Execute the two already-written-but-never-run e2e suites for the scheduling feature (commit d3e2496b), fix whatever they find, and confirm the feature works live. They were written 2026-07-10 but the session limit hit before either could run.

## Context

The scheduling feature (schedule messages into chats, schedule new chats, Schedule view) shipped in commits 5b624f15..3d1fdffa. Unit tests (40+), typecheck, and vitest all pass; a review agent's 5 findings were fixed in 5548c0a7. What has NEVER run: the live fire path (daemon tick actually delivering a scheduled message / spawning a scheduled chat) and any rendered UI. See memory `project_scheduling_feature.md` for the claim_for_fire protocol.

Both suites isolate via `CC_DAEMON_INSTANCE` (never touch the real daemon) and clean up their own `scheduled-items.json` entries (shared app-data - Drop-guards / afterEach handle it).

## Approach

1. **Daemon fire path** (burns ~2 tiny haiku turns of quota):
   `cargo test --manifest-path src-tauri/Cargo.toml --test daemon_schedule_e2e -- --ignored --nocapture`
   Test 1: tick loop autonomously fires a due scheduled message into a live session → status Sent. Test 2: schedule_fire_now spawns a scheduled NewChat. 10-min timeout. NEVER run bare `cargo test` (kills the live daemon).
2. **Schedule view UI smoke** (free, no billed turns): needs debug binaries current (`cargo build --manifest-path src-tauri/Cargo.toml`), port 1420 free, tauri-driver + msedgedriver present:
   `npm run test:e2e:schedule`
3. Fix any product defect found (fire never happens, wrong status, view DOM mismatch); re-run to green; `/commit` fixes.
4. After green: relaunch/dev-run the app for the visual pass Joe still hasn't seen (picker, chip, Schedule view) - coordinate first, dev rebuild bounces live chats.

## Acceptance

- Both suites green.
- No orphan cc-conductor-daemon.exe (instance labels test-schedule/wdio) or vite/tauri-driver processes after the runs.
- `scheduled-items.json` contains no test ids afterward.
- Any fixes committed via /commit.
