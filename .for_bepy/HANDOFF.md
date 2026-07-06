# Session Handoff

Updated 2026-07-06 by the autopilot run (see COMMENTS_FOR_BEPY.md same-date ledger for full detail).

## Current state

- Tree clean at 31a298fc; cargo build, `pnpm tsc --noEmit`, and the full vitest suite (478 tests) all green.
- The old handoff's open items are resolved: toast multiplication fixed (ai_todo 149, main-window-only), pipe-drop io::Error logging added (ai_todo 150), and the 6/29 duplicate-spawn-guard bug is tracked as ai_todo 151 (parked: needs live pipe-drop verification before touching the spawn race).
- Only genuinely open question from the old handoff: does the 7/1 11:26-11:29 pipe drop correlate with PC sleep/lock? Only Joe can answer.

## Suggested next steps (triaged 2026-07-06)

1. ai_todo 136 (inject formatting instructions on chat start) - highest leverage, unblocks 135/139/138.
2. ai_todo 094 (WebView2 crash auto-recovery, Option B heartbeat) - code-complete possible, live crash-sim verify goes to BEPY_TODOS.
3. ai_todo 146 (token source tracker) - FIRST grep whether instance_token_stats already carries the chat-vs-CLI dimension; if not, re-park.
4. ai_todo 135 (clickable file refs) - only after 136 lands.

## Live-verify owed (Joe or a live session)

- 153 cross-session held-message autosend: queue a message in a busy background chat, watch it send when that chat's turn ends while another chat is selected.
- 94/136 once implemented will add their own verify lines.
