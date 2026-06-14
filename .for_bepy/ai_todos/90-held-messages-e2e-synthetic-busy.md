# WebdriverIO e2e for held-messages, via a synthetic "busy" seam

## Goal
Cover the held-messages-while-busy flow end-to-end without a billed claude turn, so the real DOM wiring (chip on the working bar, dropdown, Send now, auto-flush) is regression-locked, not just the controller logic.

## Context
The held-messages feature (commits 804a973 / a892cb0) is unit-tested at the controller level (`tests/held-messages.test.mjs`, 13 cases) but has NO e2e. The blocker: the flow only triggers when the session is `busy`, which normally needs a live daemon + a real turn. Joe confirmed it works live on a dev build, but there's no automated guard against UI-wiring regressions.

Existing e2e harness: `e2e/specs/*.e2e.js` + `e2e/wdio.conf.js`. Synthetic-seam precedent for "needs live app/daemon" flows is in memory [[project_e2e_synthetic_seams]] (`register_historical_session` seed + `window.__injectEdit`).

## Approach
1. Add a test-only seam to force the active session's `busy` state from the webview, mirroring `window.__injectEdit`. Options: a `window.__setBusy(sessionId, bool)` that pokes `state.sessions[..].busy` + calls `updateThinkingBar()`, or seed a registered session via the existing historical-session seed and flip its busy flag. Keep it dev/test-gated.
2. New spec `e2e/specs/held-messages.e2e.js`: navigate to Sessions, open/seed a chat, force busy, then drive the composer: type + Enter, assert NO send + the `.held-chip-slot` chip appears with the right count; click the chip, assert the `.held-dropdown` rows; edit/clear a row, assert count drops; click `.held-send-now`, assert the bundled message lands once.
3. Auto-flush case: with items staged, flip busy false (clean completion, not question) and assert the bundle sends.
4. Wire it into package.json scripts (e.g. `test:e2e:held`).

## Acceptance
- `npm run test:e2e:held` (or the chosen script) passes against the built app.
- The spec fails if staging, the chip, the dropdown, Send now, or auto-flush regress.
- The synthetic busy seam is gated so it can't be hit in a production build.
