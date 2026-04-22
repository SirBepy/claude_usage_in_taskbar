# claude-usage-tauri

Tauri 2.x rewrite of the Claude Usage Taskbar Tool. Windows MVP.

## Dev

    cargo tauri dev

## Build

    cargo tauri build

Produces an NSIS installer in `target/release/bundle/nsis/`.

## Channel management

Beyond tracking Claude Code usage, this app now also manages Claude Code channels per project:

- See every running Claude Code instance on your machine, live.
- Configure "automated channels" per project that start at boot and stay alive. A hidden terminal is kept open for each — click **term** on its row to bring it to the foreground and type into it directly.
- Copy a phone link for any remote-control session to open it in the Claude mobile app.

Replaces the previous `obsidian_claude_remote` tray app (now discontinued and archived).
