# Claude AI Usage Toolbar

A Windows system tray app that monitors your Claude AI session usage in real time.
It polls the Claude web API every hour and shows a color-coded tray icon so you
always know how much of your session allowance you've used.

## Requirements

- Windows (macOS support planned)
- [Node.js](https://nodejs.org/) (v18+)
- Google Chrome installed (optional — used to import your existing Claude session)

## Installation

```bash
npm install
```

## Running

```bash
npm start
```

## First launch

On first launch the app needs a Claude session. It will try one of two paths:

### Option A — Import from Chrome (recommended)

If Chrome is installed and you're already logged in to claude.ai there, the app
shows a profile picker. Select your Chrome profile and the app will read and
decrypt Chrome's cookies to import your Claude session automatically. Chrome can
be open or closed.

### Option B — Log in manually

If Chrome is not detected, a login window opens directly to `https://claude.ai/login`.
Sign in (Google OAuth is supported). Once login is detected the window closes and
the app starts polling.

After a successful login the session is saved, so subsequent launches skip this
step entirely.

## Tray icon

The tray icon is a colored circle that reflects your current session usage:

| Color  | Meaning              |
|--------|----------------------|
| Blue   | Loading / unknown    |
| Green  | < 50% used           |
| Orange | 50–80% used          |
| Red    | > 80% used           |

Click the tray icon to open the usage detail popup.

## Usage popup

The popup shows your current session usage breakdown pulled from the Claude API.
If the API response format changes and usage fields can't be parsed, the raw JSON
is displayed so you can identify the new field names.

## How it works

- All API requests reuse the Electron session cookies — no API key or token needed.
- Usage is polled once per hour automatically.
- Your org ID is cached in `config.json` (inside Electron's `userData` folder) to
  avoid an extra API round-trip on each startup.
- If the app receives a 401/403 from the API it clears the session and shows the
  login window again.

## Project structure

| File | Role |
|---|---|
| `main.js` | All app logic: tray, polling, API calls, Chrome import, IPC handlers |
| `preload.js` | Exposes `window.electronAPI` to the usage popup |
| `profile-preload.js` | Exposes `window.profileAPI` to the profile picker |
| `popup.html` | Frameless usage detail window (opens above tray on click) |
| `profile-picker.html` | Chrome profile selection window shown on first launch |
