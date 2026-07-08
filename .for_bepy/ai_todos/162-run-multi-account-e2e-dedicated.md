# Run the written-not-run multi-account e2e suites in a dedicated session

**Type:** task

## Goal
Execute the two multi-account e2e suites that were authored during the 2026-07-07 autopilot run but could not run alongside the live tray app/daemon.

## Context
- `src-tauri/tests/daemon_multi_account_spawn_env_e2e.rs` (`#[ignore]`) verifies CLAUDE_CONFIG_DIR injection + ANTHROPIC_API_KEY/CLAUDE_CODE_OAUTH_TOKEN scrubbing on a real spawn using a fake `claude.cmd` stub on a poisoned PATH. Running it while the dev daemon was live HUNG for 10+ minutes (pipe collision) and had to be killed. It also touches the real `accounts.json` behind an `AccountsFileGuard` (backs up/restores) - read its file header for both risks.
- `e2e/specs/multi-account.e2e.js` (WebdriverIO, `npm run test:e2e:accounts`) covers the dashboard account-selector and new-chat picker empty-registry paths. WDIO needs tauri-driver and the tray app CLOSED (one-window limit).

## Approach
Close the Claude Conductor tray app and stop `cc-conductor-daemon`. Then run `cargo test --manifest-path src-tauri/Cargo.toml --test daemon_multi_account_spawn_env_e2e -- --ignored` and `npm run test:e2e:accounts`. Fix whatever they surface. Note: once Joe has real accounts registered, the WDIO empty-registry assertions may need a guard or a temp-profile seam.

## Acceptance
Both suites executed with all assertions passing (or failures triaged into their own todos); no hang; `accounts.json` byte-identical after the cargo test.
