# WebdriverIO e2e: /close actually tears the chat down

## Goal
Add an end-to-end test that sends `/close` into a real in-app chat and asserts the session is genuinely removed from the sidebar after the skill's turn finishes, catching the "stuck closing" / "doesn't actually close" class at the real-UI level (not just the unit level).

## Context
The `/close` teardown bug was fixed at the unit level, then the detection mechanism itself was rewritten: `watchCloseLifecycle` (src/views/sessions/close-finalize.ts) no longer guesses "this is a /close turn" from the user's typed text (that used to false-fire on any message merely containing the substring "/close"). Instead the skill itself (~/.claude/skills/close/SKILL.md) emits `<cc-close:starting>` as the literal first line of output once it is genuinely running (promotes the row to "closing") and `<cc-close:done>` right before Phase 6 kills the terminal, only when Phase 6 actually proceeds (never on `--dont-close`, a failed chained command, or active background work). A turn that settles without `<cc-close:starting>` is a no-op; one that settles after `<cc-close:starting>` but without `<cc-close:done>` stands the row down (reverts to normal) instead of tearing the chat down. The live `turn_usage`/`session_ended` event is still raced against a `list_instances` registry poll once "running" so close always completes even when the event is dropped. Covered by `tests/close-finalize.test.mjs` (pure logic, mocked event source/poll/markers). What's missing is a real-flow e2e: it does not exercise the actual daemon -> app -> sidebar-row-removal path, nor that the skill's real CLI output actually carries the markers end to end.

This is the higher-fidelity net the user declined inline only because it costs a real `claude` turn per run (billable) and is flakier than vitest. The existing WebdriverIO harness already drives the full Tauri app + an isolated daemon.

## Approach
- Add a spec under `e2e/specs/` (e.g. `close-teardown.e2e.js`), modeled on the existing billable specs (`reload-dup.e2e.js`, `question-card*.e2e.js`) which already spin up a chat and send a real turn.
- Start a new chat, send `/close`, wait for the skill turn to finish, then assert the session's sidebar row is gone (and/or the session is absent from `list_instances`).
- Add an `npm run test:e2e:close` script in package.json mirroring the other `test:e2e:*` entries.
- Keep it in the billable/opt-in tier (not the FREE smoke set), since it runs a real `/close` skill turn.

## Acceptance
- `npm run test:e2e:close` boots the app + isolated daemon, runs a real `/close`, and the test goes red if the chat is NOT removed after the turn completes (verified by temporarily reverting the close-finalize fix or stubbing a dropped event), green with the fix in place.
- Bonus coverage if cheap to add: a turn whose text merely mentions "/close" in prose (not the real skill) does NOT mark the row "closing"; a `/close --dont-close` run marks the row "closing" then reverts it to normal (no teardown).
- Spec cleans up its daemon/process like the other e2e specs (no orphan `--daemon` processes).
