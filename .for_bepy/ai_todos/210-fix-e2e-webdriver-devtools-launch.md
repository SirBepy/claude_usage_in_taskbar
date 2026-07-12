# Fix e2e WebDriver harness launch failure ("DevToolsActivePort file doesn't exist")

**Type:** task

## Goal

Get `npm run test:e2e` (and single-spec runs via `--spec`) launching the debug app successfully again, so UI bugs can be verified end-to-end instead of by static code reading alone.

## Context

Tried to reproduce and verify the copy-button rich-text-paste fix (`src/shared/chat/chat-click-handlers.ts`, `handleCopyClick`) via the existing WebdriverIO harness (`e2e/wdio.conf.js`, tauri-driver + msedgedriver). Every session-creation attempt failed with:

```
session not created: DevToolsActivePort file doesn't exist
```

Confirmed via direct process checks:
- msedgedriver.exe (150.0.4078.48) version matches the installed WebView2 Runtime (150.0.4078.48) exactly - not a version mismatch.
- The debug binary itself (`src-tauri/target/debug/claude-conductor.exe`) boots and runs fine when launched directly (no tauri-driver involved) - daemon spawns, connects, no crash. So the app is healthy; the failure is specific to msedgedriver/tauri-driver's ability to attach a DevTools debug port to the WebView2 process when the launch chain originates from Claude Code's own tool-spawned process context (both Bash and PowerShell tools hit the identical error).

Working theory (unconfirmed): WebView2's renderer/GPU process needs a normal interactive window-station/desktop handle to open the DevTools pipe, and something about the process tree Claude's tools spawn under doesn't have one (or has it restricted). This is a known general class of failure for browser automation launched from service-like/non-interactive contexts, not something specific to this repo's tauri-driver config (which looks correct - same pattern the project's other e2e specs already rely on).

Reproduced independently outside any spec file via a raw WebDriver `POST /session` call (both Bash-mangled-path and correct PowerShell-path versions) - same error both times, ruling out a path-escaping bug in this repo's `wdio.conf.js`.

No orphan processes were left after any of these attempts (msedgedriver/tauri-driver/daemon/vite all confirmed absent afterward).

## Approach

Not yet investigated:
- Whether this only fails when launched from Claude's tool sandbox specifically vs. a normal interactive terminal (test manually from a real terminal window to isolate sandbox-vs-repo as the cause).
- Whether `--dangerouslyDisableSandbox` on the Bash/PowerShell tool changes anything (would confirm/deny the window-station theory).
- Whether tauri-driver needs an explicit `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` or similar env var set that it normally infers from an interactive session.
- Check msedgedriver/tauri-driver verbose logs (not just stdout/stderr, which were empty) - may need `--verbose` or a log-path flag to get past the generic error.

## Acceptance

- `npx wdio run e2e/wdio.conf.js --spec e2e/specs/smoke.e2e.js` passes from within a Claude Code tool-spawned shell (Bash or PowerShell), not just a manual interactive terminal.
- Document the actual root cause and fix (or documented workaround) inline in `e2e/wdio.conf.js`'s header comment so this doesn't get re-diagnosed from scratch next time.
