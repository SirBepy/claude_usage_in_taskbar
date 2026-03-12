# Claude AI Usage Toolbar

A Windows system tray app that shows your Claude AI usage at a glance — no browser tab needed.

## Installation

Download the latest `AI-Usage-Toolbar-Setup-x.x.x.exe` from the
[Releases page](https://github.com/SirBepy/ai_usage/releases) and run it.
No admin rights required.

The app updates itself automatically in the background.

## First launch

A login window opens — sign in to your Claude account (Google OAuth works).
Once detected, the window closes and the tray icon appears. Your session is saved,
so future launches skip this step.

## Tray icon

The icon is a dual progress ring:

- **Outer ring** — session usage (5-hour window)
- **Inner ring** — weekly usage (7-day window)

| Color  | Meaning      |
|--------|--------------|
| Green  | < 50% used   |
| Orange | 50–80% used  |
| Red    | > 80% used   |

**Left-click** to manually refresh. The outer ring spins while fetching.

**Hover** for a tooltip with exact percentages and reset times.

**Right-click** for the context menu (Refresh, Settings, Log Out, Quit).

## Settings

Open Settings from the right-click menu to change the icon style, time display format, and launch at login.

## Auto-refresh on Claude Code activity (optional)

The app listens on `http://127.0.0.1:27182/refresh` and refreshes when it receives a `POST` request.
Add this to your Claude Code settings (`~/.claude/settings.json` on Windows: `%APPDATA%\..\Roaming\Claude\settings.json` or `%USERPROFILE%\.claude\settings.json`) to refresh automatically after every response:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST http://127.0.0.1:27182/refresh"
          }
        ]
      }
    ]
  }
}
```

`curl` is included with Windows 10/11 — no extra software needed.

## Code signing

Windows releases are signed. See [CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md) for details.

> Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).
