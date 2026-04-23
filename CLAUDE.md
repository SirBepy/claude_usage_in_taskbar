# Claude AI Usage Toolbar

Windows system tray app (Tauri 2) that monitors Claude AI usage by scraping
the Claude settings/usage page via a CDP-driven hidden Chrome tab, once per
hour. macOS + Linux builds deferred.

## Running

```bash
cd src-tauri
cargo tauri dev
```

Production build:

```bash
cd src-tauri
cargo tauri build
```

Requires Rust toolchain at `~/.cargo/bin` + Tauri CLI v2 (`cargo install tauri-cli --version "^2.0"`).

## Architecture

**Single Rust binary + static webview assets.** Rust owns tray, scraping,
scheduling, IPC, notifications. Webview serves the dashboard as a tiny SPA.

| File | Role |
|---|---|
| `src-tauri/src/main.rs` | App entry - builds Tauri app, wires plugins, kicks off scheduler |
| `src-tauri/src/lib.rs` | Module root |
| `src-tauri/src/auth.rs` | Native browser sign-in - spawns Chrome with CDP, extracts sessionKey |
| `src-tauri/src/cdp.rs` | Chrome DevTools Protocol client (WebSocket, Fetch domain) |
| `src-tauri/src/scraper.rs` | Fetches usage JSON via hidden Chrome tab + CDP Fetch interception |
| `src-tauri/src/session.rs` | Loads/saves sessionKey cookie, verifies it against the API |
| `src-tauri/src/scheduler.rs` | Hourly poll loop, retry/backoff, triggers tray updates |
| `src-tauri/src/hook_server.rs` | HTTP hook server for Claude Code stop/notify hooks |
| `src-tauri/src/ipc.rs` | Tauri command handlers exposed to the webview |
| `src-tauri/src/state.rs` | Shared app state across threads |
| `src-tauri/src/tray.rs` | Tray icon menu, display mode cycling, threshold checking |
| `src-tauri/src/icon.rs` | Tray icon rendering (rings; Bars + Digits + spin anim pending) |
| `src-tauri/src/icon_settings.rs` | Icon color/threshold logic |
| `src-tauri/src/display_state.rs` | Tracks which display mode is currently shown |
| `src-tauri/src/fonts.rs` | Pixel font definitions for future Digits mode |
| `src-tauri/src/usage_parser.rs` | Parses `five_hour` / `seven_day` fields from API response |
| `src-tauri/src/history.rs` | Snapshot persistence (history.jsonl read/write/prune) |
| `src-tauri/src/settings.rs` | Load/save user settings to disk |
| `src-tauri/src/paths.rs` | App data / session / sound-pack / piper path helpers |
| `src-tauri/src/notifications.rs` | Notification rule resolution + event firing + mute gating |
| `src-tauri/src/project_overrides.rs` | Per-project notification override parser |
| `src-tauri/src/soundpacks.rs` | Sound pack catalog, install (download+unzip), path resolution |
| `src-tauri/src/audio.rs` | Base64 data URL serving of pack audio files to the webview |
| `src-tauri/src/piper.rs` | Piper TTS integration (binary resolution; port WIP) |
| `src-tauri/src/token_stats.rs` | Token stats scaffolding (JSONL walker pending) |
| `src-tauri/src/types.rs` | Shared data structures |
| `src/dashboard.html` | Dashboard + settings UI (single-file SPA) |
| `src/dashboard.css` | Dashboard styles |
| `src/dashboard.js` | Dashboard renderer logic |
| `src/modules/*.js` | Chart, formatters, settings, sound-packs, stats, speech-fallback |
| `src-tauri/capabilities/default.json` | Tauri 2 IPC permission allowlist |
| `src-tauri/icons/` | Build-time tray + installer icons (committed; regenerate via `cargo tauri icon <source.png>` if logo changes) |
| `src-tauri/assets/` | Bundled fonts + default notification sounds |
| `src-tauri/binaries/piper/` | Sidecar Piper TTS binary (per-target-triple name) |
| `src-tauri/tauri.conf.json` | Tauri config - bundle, updater, windows, frontend path |
| `src-tauri/Cargo.toml` | Rust deps |
| `src-tauri/build.rs` | Build-time asset/icon checks |

## Authentication flow

1. On startup, try to resume from the saved `sessionKey` (stored at
   `<app-data>/session.txt`).
2. If missing or unverified, launch the **native browser sign-in flow**:
   a. Spawn Chrome with a dedicated persistent profile
      (`<app-data>/chrome-login-profile`) and CDP enabled on a random port.
   b. Point Chrome at `https://claude.ai/login`.
   c. After the user logs in, read cookies via CDP
      `Network.getAllCookies`, extract `sessionKey`, persist it.
3. Verify the sessionKey by hitting the usage API once. If it works, continue
   polling. If not, re-launch Chrome for another login attempt.

Cookie profile persists across launches so Google re-login is avoided.

## Usage scraping

`scraper.rs` uses a CDP-driven hidden Chrome tab rather than a direct HTTP
call (API rejects replicated browser headers). Flow:

1. Connect to the already-running Chrome instance via CDP.
2. Open a new target, enable the **Fetch domain** with URL pattern
   `*/api/organizations/*/usage`.
3. Navigate to `https://claude.ai/settings/usage`.
4. When the page's own API call is paused by the Fetch domain, read the body
   via `Fetch.getResponseBody` and `Fetch.continueRequest`.
5. Parse JSON, return; close the target.

A redirect to `/login` signals expired session - rejects with 401 and
triggers re-auth.

## API response shape

```json
{
  "five_hour": { "utilization": 30, "resets_at": "<ISO8601>" },
  "seven_day": { "utilization": 36, "resets_at": "<ISO8601>" },
  "extra_usage": { "is_enabled": false, "used_credits": 0.0, "monthly_limit": 0.0 }
}
```

`five_hour.utilization` = session (5-hour window) percentage 0-100.
`seven_day.utilization` = weekly (7-day window) percentage 0-100.
`extra_usage.used_credits` and `monthly_limit` are `f64`.

## Tray icon

Generated at runtime as a 22x22 RGBA PNG. Rendered in `src-tauri/src/icon.rs`.

**Rings mode (currently implemented):** dual concentric rings
- Outer: session utilisation
- Inner: weekly utilisation
- Coloured by urgency: Blue (loading), Green (<50%), Orange (50-80%), Red (>80%)

**Bars / Digits / spin-animation modes:** enum values exist but not yet
rendered. Tracked as follow-up tickets.

## Sound packs

Notifications play any sound from the bundled **default** pack or any
**downloaded pack** (e.g. `peon`, `peasant`, `acolyte`). Packs install on
demand via the `install_sound_pack` Tauri command and land in
`<app-data>/sound-packs/<packId>/`. Per-project overrides live under
`settings.projectNotifOverrides[cwdKey][eventKey]`, gated by an `enabled`
flag; when off the event falls back to the default rule. Resolver in
`notifications::resolve_notif_config` (`src-tauri/src/notifications.rs`). Sound files
served to the frontend as base64 data URLs via `sound_pack_file_url`.

## Keeping README up to date

**Whenever the authentication flow, tray behaviour, scraping approach, or
project structure changes, update `README.md` to match.** README is
user-facing; CLAUDE.md is the developer reference. Both stay in sync.

## Key dependencies

| Package | Why |
|---|---|
| `tauri` v2 | App framework |
| `tauri-plugin-updater` | Auto-update via signed installer |
| `tauri-plugin-autostart` | Launch on login |
| `reqwest` (with gzip/brotli/deflate) | HTTP client for API + sound-pack downloads |
| `tokio` | Async runtime |
| `serde` / `serde_json` | Config + API payload parsing |
| `zip` | Sound pack extraction |

## Navigation (updated by Plan A)

The dashboard uses a sidemenu-driven navigation with four top-level views:

- **Home** (`view-dashboard`) — two enlarged Session + Weekly cards.
- **Statistics** (`view-statistics`) — pace charts, history chart, extra-usage summary.
- **Projects** (`view-projects`) — project cards (grid or list toggle). Click a card → `view-project-detail`.
- **Settings** (`view-settings`) — plus the existing `-visuals` / `-themes` / `-notifications` subviews.

The sidemenu is a fixed overlay (`#sidemenu`) slid in via CSS transform. Every top-level view has a burger button (`data-burger="true"`) that opens it. Backdrop click closes it.

## Instance detection (Plan B)

- `src-tauri/src/instances.rs` — in-memory registry keyed by `session_id`. Emits `instances-changed` Tauri events on every mutation.
- `src-tauri/src/hook_server.rs` — `/hooks/session-start` and `/hooks/session-end` endpoints populate the registry.
- `src-tauri/src/detector.rs` — 5s reconciliation loop using `sysinfo`. Marks instances as ended after 2 consecutive missing-pid ticks.
- `src-tauri/src/session_files.rs` — resolves `bridgeSessionId` from `~/.claude/sessions/<pid>.json` for phone-link URLs.
- `src-tauri/src/hook_installer.rs` — merges our SessionStart/SessionEnd entries into `~/.claude/settings.json`. Preserves every unrelated field, idempotent.
- First-run modal in `dashboard.html` asks the user to allow the global hook install; "Never" button declines permanently.
- Project cards on the Projects view surface live-instance count and remote/automated tags.
- Running-instances list on the Project detail view shows per-instance actions. Terminal/restart/stop are automated-only; phone-link requires a resolved `bridgeSessionId`.

## Channel management (Plan C)

- `src-tauri/src/channels.rs` owns automated channel lifecycle: spawn, kill tree, restart-with-backoff, show/hide console. Windows-only.
- Spawn uses raw `CreateProcessW` with `STARTF_USESHOWWINDOW | SW_HIDE` in `STARTUPINFOW` so the new console is born invisible (no flash) and `CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP`. Command line: `cmd.exe /C claude --remote-control --remote-control-session-name-prefix "<prefix>" [--continue]`.
- After spawn, hwnd resolved via `EnumWindows` by owning pid, then `strip_console_chrome` removes `WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_THICKFRAME` so the console is frameless when shown. No X button: user can't kill the process by closing the window; only the dashboard's Stop action does. Hide/Stop/Restart live in the Project detail view.
- Watchdog blocks on `WaitForSingleObject` via `tokio::task::spawn_blocking` (SpawnOutput now exposes a raw `process_handle: isize`, no tokio `Child`). Drives `next_restart_delay` (stable >5s → immediate restart; early exit → 2/4/8/16s backoff; 5 cap-bucket failures → Crashed).
- Kill on shutdown uses `taskkill /T /F /PID <pid>` — claude spawns node subprocesses so tree-kill is required.
- `src-tauri/src/vault_detector.rs` reads `%APPDATA%\Obsidian\obsidian.json` for the automation picker.
- `ipc::import_legacy_obsidian_config` maps the old Python app's config.json into a new ProjectConfig with an auto-configured automation.
- The `obsidian_claude_remote` repo is archived on GitHub as of 2026-04-21; see its README.
