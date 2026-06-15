# Manual tasks for Joe

### Urgent

- Relaunch the Claude Usage tray app if it's not running - usage tracking is off while it's down.
- Get a dev port for claude_usage from server_supervisor's allocator, then tell me to apply it (ai_todo 78). Until then claude_usage still defaults to 1420.

### Remote phone cockpit - how to test (shipped v0.1.85)

The daemon now serves a minimal remote console you can drive from your phone over Tailscale. It's a bare console (raw-ish event log, send/cancel) - the polished real-UI PWA is ai_todo 105.

1. Make sure the app is running and updated to >= 0.1.85 (so the daemon includes the remote server). It binds `127.0.0.1:27183`.
2. One-time, on the PC - expose it on your tailnet (the daemon also logs this exact line on startup):
   ```
   tailscale serve --bg --https=443 http://127.0.0.1:27183
   ```
3. Get the token (it persists across restarts - reuse the same one):
   ```
   Get-Content "$env:APPDATA\claude-usage-tauri\remote-access-token.txt"
   ```
4. On your phone (same tailnet), open in the browser:
   ```
   https://<your-pc-magicdns-name>/
   ```
   Paste the token -> you get the console: list sessions, tap one to watch its live stream, type to send a message, "Cancel turn" to interrupt.
5. Local sanity (no phone/Tailscale needed), from the PC:
   ```
   curl.exe http://127.0.0.1:27183/api/health                                          # -> ok
   curl.exe -i http://127.0.0.1:27183/api/sessions                                     # -> 401 (no token)
   curl.exe -H "Authorization: Bearer <TOKEN>" http://127.0.0.1:27183/api/sessions     # -> JSON session list
   ```

**Eyeball first** (couldn't be tested headless): the WebSocket **live stream** and the embedded page rendering on the phone. If the stream log stays empty while a turn runs, it's most likely the `ChatEvent` JSON shape vs the console's generic renderer - tell me, it's a ~2-line tweak.

**Security notes:** localhost-bound, so nothing is reachable until you run `tailscale serve`. Only the token's hash is stored; the plaintext lives in `remote-access-token.txt` - delete that file after copying it (only the hash is needed). Every data route requires the bearer token (fail-closed); dangerous daemon methods are blocked by an allowlist.
