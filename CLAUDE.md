# Claude AI Usage Toolbar

Windows (future: macOS) system tray app that monitors Claude AI usage by polling
the Claude web API every hour using the session from an embedded login browser.

## Running

```bash
npm install
npm start
```

## Architecture

**Single process: Electron main** (`main.js`) — no renderer bundle, no build step.

| File | Role |
|---|---|
| `main.js` | All app logic: tray, polling, API calls, Chrome import, IPC handlers |
| `preload.js` | Exposes `window.electronAPI` to the usage popup (`popup.html`) |
| `profile-preload.js` | Exposes `window.profileAPI` to the profile picker (`profile-picker.html`) |
| `popup.html` | Frameless 320×240 usage detail window (opens above tray on click) |
| `profile-picker.html` | Profile selection window shown on first launch |

## Authentication flow

1. On startup, try to resume from a saved session (Electron persists cookies across runs).
2. If no session, check for Chrome profiles (`listChromeProfiles`).
3. **If Chrome profiles exist** → show `profile-picker.html`. User picks a profile;
   `importChromeProfile()` reads and decrypts Chrome's `Cookies` SQLite file and
   imports `claude.ai` cookies into Electron's default session.
4. **If no Chrome** → show `https://claude.ai/login` in a full `BrowserWindow`.
   Google OAuth popups are allowed via `setWindowOpenHandler`. Navigation away
   from auth pages triggers `tryAutoDetectLogin` which polls the API to confirm.

## API calls

All HTTP requests use `net.request({ session: electronSession.defaultSession })`
so they automatically carry the logged-in session cookies — no manual token needed.

Key endpoints:
- `GET /api/organizations` — resolves org ID (cached to `config.json`)
- `GET /api/organizations/{id}/usage` — usage data, polled every hour

401/403 → clears session, shows login window.

## Chrome cookie import (Windows)

Chrome locks its `Cookies` SQLite file while running. Standard `fs.copyFileSync`
fails with EBUSY. The workaround (`safeCopyLockedFile`) uses **inline C# in
PowerShell** to call Win32 `CreateFile` with:
- `FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE` (dwShareMode = 7)
- `FILE_FLAG_BACKUP_SEMANTICS` (dwFlagsAndAttributes = 0x02000000)

The copied database is read with `sql.js` (WASM SQLite, no native build tools).

Cookie values are AES-256-GCM encrypted; the key lives in Chrome's `Local State`
under `os_crypt.encrypted_key`, itself DPAPI-encrypted. Key decryption uses a
second PowerShell script via `ProtectedData.Unprotect`.

**macOS** (future): key is in Keychain (`Chrome Safe Storage`), cookies use
AES-128-CBC with PBKDF2-SHA1. Skeleton is in place in `getChromeAesKey` /
`decryptChromeValue`.

## Tray icon

Generated at runtime as a 22×22 RGBA PNG (circle with transparent corners) using
only Node built-ins (`zlib` + `Buffer`). Color encodes current session usage:
- Blue — unknown / loading
- Green — < 50 %
- Orange — 50–80 %
- Red — > 80 %

## Usage popup

`popup.html` uses a flexible `deepFind` parser that searches the API response
for common field name variants (`session_percentage`, `messages_used / messages_allowed`,
etc.). If no percentage fields are recognised it falls back to displaying the raw
JSON so the field names can be identified and the parser updated.

## Config

Stored in Electron's `userData` directory (`app.getPath('userData')/config.json`).
Currently only caches `orgId` to avoid an extra API round-trip on each startup.

## Key dependencies

| Package | Why |
|---|---|
| `electron` (devDep) | App framework |
| `sql.js` | Pure-WASM SQLite — reads Chrome's Cookies DB without native build tools |
