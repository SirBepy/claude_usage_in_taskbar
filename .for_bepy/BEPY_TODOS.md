# Manual tasks for Joe

### Urgent

- Relaunch the Claude Usage tray app - I killed it during the AFK e2e run (the wdio harness kept nuking its daemon); it's currently down so usage tracking is off.
- Get a dev port for claude_usage from server_supervisor's allocator, then tell me to apply it (ai_todo 78). Until then claude_usage still defaults to 1420.

### Visual QA

- Permission-on-backgrounded-chat (ai_todo 79): start a tool-heavy turn in chat A, switch to chat B; confirm A's sidebar row highlights + the shield icon pulses amber and sorts to the top. Click A: the permission/question card should surface and answering it lets the turn continue. (Gating/store logic is unit-tested; needs your eyes on the highlight + live answer.)
- Changes-panel checkbox (ai_todo 80): open a chat's all-changes rail with a long file list, scroll down, tick a "reviewed" checkbox; confirm the "N of M reviewed" chip updates without the list rebuilding or the scroll jumping. Opening a row's diff sheet should still work.
