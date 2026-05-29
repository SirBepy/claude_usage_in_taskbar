# Manual tasks for Joe

### Urgent

- Relaunch the Claude Usage tray app - I killed it during the AFK e2e run (the wdio harness kept nuking its daemon); it's currently down so usage tracking is off.
- Get a dev port for claude_usage from server_supervisor's allocator, then tell me to apply it (ai_todo 78). Until then claude_usage still defaults to 1420.

### Visual QA

- Permission-on-backgrounded-chat (ai_todo 79): start a tool-heavy turn in chat A, switch to chat B; confirm A's sidebar row highlights + the shield icon pulses amber and sorts to the top. Click A: the permission/question card should surface and answering it lets the turn continue. (Gating/store logic is unit-tested; needs your eyes on the highlight + live answer.)
- Changes-panel checkbox (ai_todo 80): open a chat's all-changes rail with a long file list, scroll down, tick a "reviewed" checkbox; confirm the "N of M reviewed" chip updates without the list rebuilding or the scroll jumping. Opening a row's diff sheet should still work.
- Project-detail "+" new chat: open a project detail, click the + on the right of the RUNNING INSTANCES header; confirm the model/effort modal appears, picking one switches to Chats with a fresh draft for that project. (If you actually wanted this to open a detached window instead of the in-app Chats route, tell me.)
- Project-detail recent-chats overflow: confirm the recent-chats table no longer spills past the card edge - long chat names should ellipsis-truncate.
- Chat-detail revamp: open a CLOSED chat (from project-detail recent chats) - confirm the new cards render (title from history not the id, Date | Time row, Total tokens, Turns/Messages, token pie + legend, cache read/create/efficiency). Then open a LIVE chat (running instance) - confirm it shows the reduced set (overview + turns/messages, no pie/cache) and updates live.
- Chat-detail actions: the header ⋮ menu should Copy PID (live only) and Copy Session id; the "Open in chats" CTA should open a live chat in Chats and a closed chat read-only in History.
