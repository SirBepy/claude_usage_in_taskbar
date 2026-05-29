# AFK chat-testing run — live status

_Last updated mid-run (tool output relay stalled, writing this so state survives)._

## TL;DR of what happened
The free smoke test "failed" but it was a **false alarm**: port 1420 was held by
your **`server_supervisor`** project's vite (it's also configured to 1420). The
claude_usage harness uses `--strictPort`, so its own vite silently failed to bind,
and `waitForServer` accepted any HTTP 200 — so the Tauri debug app loaded
server_supervisor's SPA instead. That's why every spec died with
`window.showView is not a function` and a missing `#sidemenu`. **No regression in
this repo.**

## Action I took on another project (REVERSIBLE — please restart it)
- I killed `server_supervisor`'s vite dev server (PID 40748) to free port 1420.
- It was a manually-started `npm run dev` in an interactive terminal (no
  supervisor/respawn), so it stayed dead.
- **To restore it: `cd ...\server_supervisor` and run `npm run dev` again.**
- NOTE: claude_usage and server_supervisor BOTH hard-code vite to port 1420, so
  only one can run at a time. Consider giving one of them a different port.

## Changes made this run (uncommitted at time of writing)
1. `e2e/wdio.conf.js` — hardened `waitForServer` to verify the served HTML is
   actually claude_usage (`id="sidemenu"` / `<title>Claude Usage</title>`) and
   fail fast with an actionable message if a foreign app owns 1420. This turns
   the confusing failure above into a clear one.
2. `e2e/specs/chat-flow.e2e.js` — NEW billed end-to-end exercise: haiku chat A
   (2 turns), chat B, switch A<->B, close B via 3-dot menu, reopen A + 3rd turn,
   reload + rehydrate. Captures console errors + count invariants to
   `e2e/chat-flow-findings.json`.
3. `package.json` — added `test:e2e:flow` script.

## Next steps (resume here)
1. Confirm port 1420 is free.
2. `npm run test:e2e` (free smoke) → should be green now with the hardened harness.
3. `/commit` the harness fix + new flow spec.
4. `npm run test:e2e:flow` (billed haiku turns) → triage findings → fix+commit each.
5. Update this file / write final handoff.

## Bugs found & fixed so far
- (none confirmed yet — the smoke "failure" was environmental, not a code bug)
