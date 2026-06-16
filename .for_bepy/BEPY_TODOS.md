# Manual tasks for Joe

### Urgent

- Relaunch the Claude Usage tray app if it's not running - usage tracking is off while it's down.
- Get a dev port for claude_usage from server_supervisor's allocator, then tell me to apply it (ai_todo 78). Until then claude_usage still defaults to 1420.

### Manual QA (needs relaunch / live)

- After the next build+relaunch, confirm the AFK relay fix (ai_todo 100, commit 95db1c1): start an in-app chat that triggers a permission prompt OR an AskUserQuestion, then leave it unanswered for >6 minutes (past the old 320s cap). When you come back and answer, it should still go through - no "error sending request for url .../permissions/request" and no hung turn. The daemon already holds prompts for 1h; this just stops both relay clients (MCP relay + the AskUserQuestion curl hook) from giving up at 5.3 min first. Backend change - requires a daemon rebuild+relaunch to take effect.

### Visual QA

- After the next build, confirm the 0.1.89 fix end-to-end: app boots normally, Settings > Statusline > Back works again, and Settings > About > the GitHub/YouTube dev-link buttons open in the browser (now routed through the app's `open_external` IPC).
- After the next build, eyeball project tech-logos (ai_todo 99): projects with no custom emoji/image avatar should now show their real icon file (icon.png/logo.svg/favicon) OR a Devicon tech logo (rust/node/python/flutter/go/deno/dotnet) OR a generic folder, in BOTH the projects list and the project-detail header. Custom emoji/image/character avatars must be unchanged. Devicon loads from unpkg (needs internet on first paint). If a logo is missing, check the browser console for a devicon CSS/font load error.
- After the next build, confirm the working-chip highlight: while a chat works, only ONE chip pulses (the current action, e.g. File Changes while "Editing x.ts") and the highlight MOVES as the activity moves - not the whole strip lit up at once.
- After the next build, confirm held-message auto-send: while a chat is working, send a message (it shows "N waiting" + "Send now"), then DON'T touch the composer - when the turn finishes it should auto-send on its own within ~2s (no "Send now" click). Was hanging when the turn ended right after your keystroke. (It still holds, by design, if the turn ends on a question.)
- After the next build, eyeball that character icons still load in all three surfaces (ai_todo 101 collapsed them onto one shared `character-icon.ts` cache): the Change-character modal grid, the whitelist editor rows (Settings + per-project), and the sessions sidebar/header faces. Pure refactor, tsc + full vitest green; just a visual confirm.
- Eyeball the new Abathur + Qhira square portraits (ai_todo 93 - needs an app relaunch / icon-cache refresh to show). They're now square opaque busts instead of the hexagonal fallback, BUT the source repo had no `heroselect_btn` art for these two, so Abathur uses an in-game target-portrait face-crop and Qhira a reward-base bust (the closest square opaque equivalents). If either looks off next to the other 88 heroes, the old hexagon icons are backed up at `C:\tmp\hex_icon_backup\abathur_icon.png` + `qhira_icon.png` - just copy back over `%APPDATA%\claude-usage-tauri\characters\heroes-of-the-storm\<id>\icon.png`.
- After the next build, confirm the draft-chat header portrait (commit 526bb9a): start a New chat, pick a character in the modal, and the chat HEADER (top of the draft pane) should show that character's photo - not the bare `?` placeholder - matching the sidebar row. If you DON'T pick one, the header shows the muted state until the session starts, then upgrades to the rolled character.
- On the PHONE (remote cockpit, #sessions) after the next deploy, confirm the mobile single-pane layout (ai_todo 115, commit 2939f3d): at a narrow width you see EITHER the session list OR the chat, never both cramped. Tapping a session opens its chat full-width; a back-arrow (←) in the header returns to the list; starting a New chat also jumps to the chat pane. Desktop webview must look identical to before (the breakpoint is 768px - resize the desktop window narrow to spot-check without a phone).

### Remote phone cockpit - LIVE PHONE TEST (real-UI PWA, autopilot 2026-06-15)

The stub console is GONE - the daemon now serves the **real chat UI** as an installable PWA. The whole core loop is built + unit/build-verified, but NONE of it is live-verified (only you can phone-test it). This is the gate.

REQUIRED FIRST: **redeploy + update.** The running daemon still serves the OLD stub until its binary is rebuilt with the embedded SPA. Run `/commit pushnbump` then let the app auto-update (or rebuild). The new daemon binds `127.0.0.1:27183` as before.

1. One-time on the PC, expose it on your tailnet (the daemon logs this exact line on startup):
   ```
   tailscale serve --bg --https=443 http://127.0.0.1:27183
   ```
2. Get the token (persists across restarts):
   ```
   Get-Content "$env:APPDATA\claude-usage-tauri\remote-access-token.txt"
   ```
3. On your phone (same tailnet), open `https://<your-pc-magicdns-name>/`. If it's a fresh phone you get a token-entry screen (paste the token); if you used the old stub the token is already in localStorage. You should land in the **real app UI**.

VERIFY (the things that couldn't be tested headless):
- The real chat UI loads (not the old raw console), session list shows, and it stays live (polls every ~3.5s).
- Open one of your existing chats -> **past messages render** (new daemon history RPC) -> with real content, not `[user_message]` tags.
- Send a message FROM the phone -> it shows as your bubble on BOTH the phone AND the PC (the user-echo fix), and the AI reply streams to both.
- "Add to Home Screen" -> it installs as a PWA (manifest + service worker).

Local sanity (no phone needed), from the PC after redeploy:
```
curl.exe http://127.0.0.1:27183/api/health                                       # -> ok
curl.exe -i http://127.0.0.1:27183/                                              # -> 200 + the real index.html
curl.exe -i http://127.0.0.1:27183/api/sessions                                 # -> 401 (no token)
curl.exe -H "Authorization: Bearer <TOKEN>" http://127.0.0.1:27183/api/sessions  # -> JSON session list
```

KNOWN DEGRADES (parked in ai_todo 105, not bugs): starting a NEW chat from the phone isn't wired yet (open existing ones); image attachments send as text-only; permission/AUQ prompts don't yet auto-surface on the phone; usage/token dashboards + custom settings (models/presets) are app-side only (phone uses defaults). Tell me if any of these matter and I'll prioritize them.

**Security:** unchanged - localhost-bound (nothing reachable until `tailscale serve`), only the token hash is stored (delete `remote-access-token.txt` after copying), every `/api` route is token-gated fail-closed, dangerous daemon methods blocked by an allowlist. The SPA HTML/JS is served unauthenticated (no secrets in it; it authes every API call with the token).
