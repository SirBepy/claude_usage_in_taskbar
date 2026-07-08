# Fix the wdio e2e harness: WebView2 session creation broken

**Type:** task

## Goal
Make `pnpm test:e2e` (tauri-driver + msedgedriver) able to create a session again, then run the new wizard describe block in `e2e/specs/multi-account.e2e.js` (written 2026-07-08, syntax-checked, never executed - blocked by this).

## Context
- Symptom: every session POST fails with `session not created: DevToolsActivePort file doesn't exist`, after ~60s per attempt.
- What was already fixed: `e2e/drivers/msedgedriver.exe` was Edge 148 while the newest installed WebView2 runtime is 150.0.4078.48 - replaced with the matching 150.0.4078.48 driver (from `https://msedgedriver.microsoft.com/150.0.4078.48/edgedriver_win64.zip`). The version error went away; DevToolsActivePort persists.
- Findings from the 2026-07-08 debugging session:
  - The debug exe boots fine standalone (process stays alive).
  - TWO WebView2 runtimes are installed side by side: 149.0.4022.98 and 150.0.4078.48. Other running Tauri apps (pomodoro, supervisor) use 149; msedgedriver reported the conductor app resolving to 150.
  - `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223"` on a manual app launch did NOT produce a reachable CDP endpoint, and no `DevToolsActivePort` file appeared under `%LOCALAPPDATA%\com.sirbepy.claude-conductor\EBWebView`. Oddly, no conductor-owned `msedgewebview2.exe` processes were observed at all during those manual launches (only 8-12s observation windows; check longer / check the correct user-data-dir path first - the dir name is an assumption).
  - No stale msedgedriver/tauri-driver orphans, port 4444 free, tauri-driver 2.0.6 (latest).
- Suspects, in order: (1) the app's WebView2 environment not honoring the debugging env var on runtime 150 (or Tauri/wry overriding additionalBrowserArguments), (2) msedgedriver 150's WebView2 launch contract changing (needs `ms:edgeOptions.webviewOptions` that tauri-driver 2.0.6 doesn't send), (3) wrong user-data-dir expectations between driver and app.
- Meanwhile the wizard flow has headless coverage: `tests/add-account-wizard-dom.test.mjs` (real wizard module + mocked IPC) and `tests/confirm.test.mjs`. The e2e spec would add real-IPC coverage (profile-dir creation/cleanup, real modal in the real webview).

## Acceptance
- `pnpm test:e2e:accounts` creates a session and runs; the wizard describe block passes (or its real-run failures are fixed).
- Note what the root cause was in the spec header comment so the next runtime auto-update doesn't cost another debugging session.
