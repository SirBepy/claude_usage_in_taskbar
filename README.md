# Claude AI Usage Toolbar

A Windows system tray app that shows your Claude AI usage at a glance — no browser tab needed.

## Installation

Download the latest `AI-Usage-Toolbar-Setup-x.x.x.exe` (Windows) or `.dmg` / `.zip` (macOS) from the
[Releases page](https://github.com/SirBepy/claude_usage_in_taskbar/releases) and run it.
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

Your default browser opens to claude.ai/login - sign in with your Claude account
(Google OAuth works). After logging in, use the bookmarklet shown in the status
window to transfer your session to the app. The tray icon appears once connected.
Your session is saved, so future launches skip this step.

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

The app listens on `http://127.0.0.1:27182/refresh` and `/notify` for Claude Code hooks.

**Minimal setup** (refresh only, no click-to-focus):

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "curl -s -X POST -H \"Content-Type: application/json\" --data-binary @- http://127.0.0.1:27182/refresh" }] }]
  }
}
```

**Recommended setup** (click notification → focus the exact terminal/VSCode window that fired the hook):

Copy [scripts/aiusage-hook.ps1](scripts/aiusage-hook.ps1) to `%USERPROFILE%\.claude\aiusage-hook.ps1`, then:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "powershell -NoProfile -ExecutionPolicy Bypass -File \"%USERPROFILE%\\.claude\\aiusage-hook.ps1\" refresh" }] }
    ],
    "Notification": [
      { "hooks": [{ "type": "command", "command": "powershell -NoProfile -ExecutionPolicy Bypass -File \"%USERPROFILE%\\.claude\\aiusage-hook.ps1\" notify" }] }
    ]
  }
}
```

The wrapper script forwards the hook payload plus the originating terminal's env vars (`TERM_PROGRAM`, `VSCODE_IPC_HOOK_CLI`, `WT_SESSION`) and parent-PID chain. Clicking a notification then routes to the right window:

- **VSCode integrated terminal** → `code -r <cwd>` focuses the window hosting that workspace.
- **Windows Terminal / pwsh / cmd / WezTerm / etc.** → walks the PID chain and `SetForegroundWindow`s the first ancestor with a visible window.
- **Fallback** → legacy title-match on VSCode processes.
