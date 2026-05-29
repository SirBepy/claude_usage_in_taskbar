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
### FIXED
- e2e harness loaded the wrong SPA when port 1420 was taken (commit 60a9cf1). Not
  an app bug, but a real harness footgun. Done.

### CANDIDATE bugs from static read (NEED live confirmation via flow test)
1. **Switched-away busy chat drops its permission prompt → turn hangs.**
   `permission-modal/gating.ts:isForSelectedSession()` returns false for any
   session that isn't the selected one (or explicitly backgrounded via /close).
   So: Claude runs in chat A, you switch to chat B, A hits a tool-permission
   prompt → it's silently DROPPED (logged as `[perm-gate] DROPPED`) and A's turn
   stalls with no UI. Only `/close` sessions are added to `_backgroundSessionIds`.
   A normal switched-away busy chat is not. HIGH severity if confirmed.
   Likely fix: when a busy session is switched away from, treat its prompts as
   background (queue or surface them) rather than dropping. Needs design care
   (Joe's call on UX: queue vs toast vs auto-switch).

2. **changes-panel rail re-renders via `outerHTML =` on every checkbox toggle**
   (`changes-panel.ts:99,120`), losing scroll position in a long change list and
   rebuilding all rows on each tick. LOW severity, cosmetic.

These are unverified static reads — confirm with the billed flow test before fixing.

## Billed flow test RESULT (run 2, clean field, app quit)
8/8 PASS, EXIT=0, in 51s on haiku:
- chat A first reply ✓
- chat A 2nd message same chat (multi-turn) ✓
- chat B new chat + send ✓
- switch A<->B no dup/reorder ✓
- close B via 3-dot menu, row disappears ✓
- reopen A + 3rd message after churn ✓
- reload app + A rehydrates without dup ✓
Only finding: 1 benign `[TAURI] Couldn't find callback id` warn during the
reload step (expected — app reloads mid async op).

IMPORTANT GAP: the haiku prompts were "reply with one word", which fire ZERO
tools. So candidate bug #1 (switched-away busy chat drops its permission prompt)
was NOT exercised — the test never created a pending permission on a backgrounded
chat. That bug remains a static-read suspicion, unconfirmed. To confirm it needs
a turn that (a) triggers a real tool-permission prompt AND (b) gets switched away
from before responding. Left for a follow-up test or Joe's manual check.

So: the core multi-message/switch/close/reopen/reload flows Joe described all
WORK. No bug reproduced in the exercised paths.

## BUG #1 now CONFIRMED BY CODE TRACE (not just static suspicion) — needs Joe's UX call to fix
Full path of the hang:
1. Claude (in chat A) calls a tool needing permission. Daemon emits a global
   `permission_request` notification carrying A's session_id and PARKS a oneshot
   waiting for the app to call `respond_permission` (daemon_link.rs:138 routes it
   to the `permission-requested` Tauri event; the daemon side holds the pending
   responder — see ipc/chat/lifecycle.rs:302 respond_permission + daemon/methods).
2. App frontend listener (permission-modal/index.ts:72) calls
   `isForSelectedSession(payload.session_id)` BEFORE showing the card.
3. `isForSelectedSession` (gating.ts:43) returns true ONLY if the session is the
   selected one, OR in `_backgroundSessionIds`, OR the pending realId. The
   background set is populated ONLY by the `/close` flow (active-session.ts
   addBackgroundSession). A chat you simply SWITCHED AWAY FROM is none of these.
4. => event is DROPPED (logged `[perm-gate] DROPPED permission-requested`),
   never stored, never re-emitted. The daemon oneshot never resolves.
   => chat A's turn hangs forever; switching back shows no card (no re-emit).

Severity: HIGH. Real-world trigger: start a tool-heavy turn in one chat, flip to
another chat while it works (exactly Joe's described usage), first chat silently
wedges.

Why I did NOT auto-fix it:
- The fix is a UX decision (Joe's call): options are (a) queue the pending
  prompt and re-surface it when you switch back to that chat + mark the row
  unread/attention; (b) global toast "Chat X needs permission" that jumps you
  there; (c) auto-surface the card over the current chat with a "for chat X"
  banner. Each is a different feel.
- It's a cross-file change to the permission system; doing it blind while AFK
  risks a worse regression than the bug.
- A live repro test is timing-racy (must switch away in the gap between tool_use
  and the prompt) and a flaky version could leave hung BILLED claude turns.

Recommended minimal-risk fix (any UX): never DROP. At minimum store the dropped
payload keyed by session_id and, on selectSession(id), replay any stored pending
permission/question for that id. Combine with marking the row unread so the user
knows. That's correct under all three UX choices above; the only open question is
the extra attention affordance, which is the part that's Joe's taste.

Filed as the headline item. Everything else Joe asked to test passes.

## Harness note for next run
- The wdio `onComplete` (wdio.conf.js:123) kills ANY `claude-usage-tauri.exe
  --daemon`, which matches Joe's PROD daemon, not just the isolated wdio one.
  Every harness run nukes the prod daemon. That's why the app must be fully quit
  during billed testing. Consider scoping the onComplete kill to the wdio
  instance only (match on CC_DAEMON_INSTANCE in the command line) — but the app
  spawns `--daemon` without that flag visible, so this needs thought. Logged, not
  fixed.
