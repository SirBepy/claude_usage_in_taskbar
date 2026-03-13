# Claude AI Usage Toolbar

A Windows system tray app that shows your Claude AI usage at a glance — no browser tab needed.

## Installation

Download the latest `AI-Usage-Toolbar-Setup-x.x.x.exe` (Windows) or `.dmg` / `.zip` (macOS) from the
[Releases page](https://github.com/SirBepy/ai_usage/releases) and run it.
No admin rights required.

The app updates itself automatically in the background.

### macOS Installation (Unsigned App)

Because this app is currently unsigned, macOS may flag it as "damaged" or from an "unidentified developer" when downloaded from the internet. To open it:

1.  **Right-click** the application in your `Applications` folder and select **Open**.
2.  If it still shows a "damaged" error, open **Terminal** and run:
    ```bash
    xattr -cr "/Applications/Claude Usage Taskbar Tool.app"
    ```
    This removes the internet download "quarantine" flag and allows the app to start normally.

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
