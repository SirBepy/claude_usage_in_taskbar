# claude-usage-tauri

Tauri 2.x system tray app that monitors Claude AI usage and exposes Claude Code channel management. Windows, macOS, and Linux (x86_64) supported.

## Install

Grab the latest build from the [Releases](https://github.com/SirBepy/claude_usage_in_taskbar/releases) page.

### Windows

Download `Claude-Usage-<version>-setup.exe` and run it. The NSIS installer handles autostart and desktop shortcuts.

### macOS

Download the `.dmg` matching your architecture:

- Apple Silicon (M1/M2/M3/M4): `Claude-Usage_<version>_aarch64.dmg`
- Intel: `Claude-Usage_<version>_x64.dmg`

Mount the DMG and drag **Claude Usage** to Applications.

**First launch (unsigned build workaround):** The app is not signed with an Apple Developer ID, so Gatekeeper refuses the normal double-click-open. Right-click **Claude Usage** in Applications, choose **Open**, then confirm the "unidentified developer" prompt. Only needed once; subsequent launches and auto-updates work normally.

### Linux

Two options on x86_64:

**DEB (Debian/Ubuntu):**

Download `Claude.Usage_<version>_amd64.deb` and install:

```bash
sudo apt install ./Claude.Usage_<version>_amd64.deb
```

**AppImage (any distro):**

Download `Claude.Usage_<version>_amd64.AppImage`, mark it executable, and run:

```bash
chmod +x Claude.Usage_<version>_amd64.AppImage
./Claude.Usage_<version>_amd64.AppImage
```

The app needs a Chromium-based browser (Google Chrome, Chromium, or Brave) installed for the one-time login flow.

Note: channel automation (running Claude Code remote-control instances from the dashboard) is Windows + macOS only on v1.

## Dev

```bash
cd src-tauri
cargo tauri dev
```

## Build

```bash
cd src-tauri
cargo tauri build
```

On Windows produces an NSIS installer in `src-tauri/target/release/bundle/nsis/`; on macOS produces a DMG in `src-tauri/target/<triple>/release/bundle/dmg/`.

## Channel management

Beyond tracking Claude Code usage, this app manages Claude Code channels per project:

- See every running Claude Code instance on your machine, live.
- Configure "automated channels" per project that start at boot and stay alive.
  - **Windows:** each channel runs in a hidden terminal; click **term** on its row to bring it to the foreground and type into it directly.
  - **macOS:** channels run headless (no visible console). Stop/Restart work as on Windows; Show/Hide is not applicable.
- Copy a phone link for any remote-control session to open it in the Claude mobile app.

Replaces the previous `obsidian_claude_remote` tray app (now discontinued and archived).
