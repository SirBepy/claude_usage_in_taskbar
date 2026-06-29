# Update product descriptions to reflect Claude Conductor's full scope

## Goal
Rewrite the `tauri.conf.json` bundle descriptions (which still say "monitors Claude AI usage") so they reflect that Claude Conductor is a full Claude Code cockpit — usage monitoring + live chat/sessions hub + remote phone cockpit + voice — not just a usage tray.

## Context
The rename (v0.2.0) changed the product NAME but deliberately left the functional copy untouched to avoid scope creep. The stale copy:
- `src-tauri/tauri.conf.json:40` shortDescription = `"Claude AI usage in your taskbar"`
- `src-tauri/tauri.conf.json:41` longDescription = `"Tray app that monitors Claude AI usage and shows it as progress rings in the system tray."`

These predate the chat/sessions/remote/voice features and undersell the app. `README.md` (lines 3-10) already describes the full feature set and is a good source of truth for the new copy. These descriptions flow into installer metadata (NSIS / DMG / deb), so keep them clean and accurate.

## Approach
1. Draft a shortDescription (~1 line) + longDescription (~2 sentences) covering: usage monitoring, live Claude Code chat/sessions hub, remote phone cockpit, voice mode. Mirror README.md's framing.
2. Update `tauri.conf.json:40-41`.
3. `cargo build --manifest-path src-tauri/Cargo.toml` to confirm valid JSON.

## Acceptance
tauri.conf descriptions describe the full Conductor feature set (not "usage in taskbar"); build green.
