# Manual tasks for Joe

### Urgent

### Visual QA

- Verify ai_todo 73 (daemon re-adopts external sessions on restart): start `claude` in a terminal (wait for it to show as External in Sessions), restart the daemon (kill + relaunch), confirm the external session reappears in the sidebar without needing a new hook to fire.

- Sims character audio spot-check (ai_todo 49 - redistribution done, audio check pending): open Characters view, pick 3 chars, play each slot a few times - confirm no audibly cut-off clips and consecutive triggers play different lines.
- FOUC check (ai_todo 52): confirm whether the white flash exists in the installed build before any code action. If yes, ping me.
- Tool-preview / changes-panel smoke (ai_todo 53): `cargo tauri dev` and manually eyeball the 9 criteria listed in .for_bepy/ai_todos/53-*.md.

- Run `cargo tauri dev` from `src-tauri/` and verify the Projects view: no `tauri` orphan project, no `c:` / `C:` zng-app duplicate, parent-segment suffix shows on real basename collisions, clicking a card opens the detail view.
- Update `~/.claude/skills/night-run/SKILL.md` so the tick-prompt template appends a new step: write/update `FOR_TOMORROWS_AI.md` at repo root (outcome, files changed, decisions, blockers). Lets you fully shut PC down overnight without losing handoff continuity. See request that triggered this in 2026-05-09 close session.
- Verify first-turn streaming renders live: `cargo tauri dev` → Sessions view → `+New` → pick project → type "say hi" → confirm reply appears character-by-character within 1-3s, not all-at-once after a longer pause. (was ai_todo 09b)
- Reproduce or rule out the `<command-name>` text bleeding into chat tool_result blocks: open a session that ran a slash-command (e.g. `/rate-it`), inspect a `.msg.tool-result` block in DevTools, look for raw `<command-name>` markup. If reproduced, ping me to extend `cleanUserBlocks` to cover tool_result content. (was ai_todo 18)
- Statusbar coverage extension (history view + pending pane + new effort chip): I need your taste calls before I can build it. The blockers: (a) effort-budget thresholds for Low/Med/High/Max bucketing of `~/.claude/settings.json::thinking.budgetTokens`, (b) whether history view should show duration as static total or hide it, (c) what to show in the pending pane statusbar before the first turn completes. Ping me with answers and I'll ship. (was ai_todo 10a)
- Spot-check daemon takeover end-to-end (the one bit no automated test proves): with a real terminal `claude` running (shows as External in Sessions), use the takeover action and confirm it promotes to Interactive AND a follow-up message actually resumes that real conversation. The RPC path is covered by `daemon_chat_e2e::takeover_manual_promotes_external_to_interactive`; only the live-resume needs eyes.
- Verify skill-token-tracking end-to-end: relaunch app on v0.1.47+ (forces hook-installer migration to v3 adding the Stop hook), run a Claude Code session in any project and invoke a few skills typed (`/commit`) and auto (model picks `superpowers:*`), confirm Statistics → "Skills (last 7 days)" populates with pie + table, click a row to confirm the detail view renders with correct `manual`/`skill`/`auto` badges. Sidemenu Skills entry should also list every installed skill.
