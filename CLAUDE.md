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
| `src-tauri/src/lib.rs` | Module declarations + run() |
| `src-tauri/src/state.rs` | Shared AppState |
| `src-tauri/src/scheduler.rs` | Hourly poll loop |
| `src-tauri/src/history.rs` | Snapshot persistence |
| `src-tauri/src/auth/session.rs` | Load/save sessionKey, verify against API |
| `src-tauri/src/auth/login_flow.rs` | Chrome CDP sign-in spawn |
| `src-tauri/src/auth/cdp.rs` | CDP WebSocket client |
| `src-tauri/src/scraping/client.rs` | Hidden-tab Fetch-domain scraper |
| `src-tauri/src/scraping/parser.rs` | five_hour/seven_day JSON parsing |
| `src-tauri/src/tray/menu.rs` | Tray icon menu + threshold check |
| `src-tauri/src/tray/icon_render.rs` | RGBA PNG rendering |
| `src-tauri/src/tray/threshold.rs` | Icon colour/threshold logic |
| `src-tauri/src/tray/display_mode.rs` | Display-mode cycling |
| `src-tauri/src/tray/fonts.rs` | Pixel font defs |
| `src-tauri/src/hooks/server.rs` | Claude Code stop/notify HTTP hooks |
| `src-tauri/src/hooks/installer.rs` | ~/.claude/settings.json merge |
| `src-tauri/src/hooks/instances.rs` | Running-instance registry |
| `src-tauri/src/hooks/detector.rs` | 5 s reconcile loop |
| `src-tauri/src/hooks/session_files.rs` | ~/.claude/sessions/<pid>.json resolver |
| `src-tauri/src/channels/spawn.rs` | CreateProcessW automation launcher |
| `src-tauri/src/channels/watchdog.rs` | Restart backoff + wait |
| `src-tauri/src/channels/window_chrome.rs` | hwnd discovery + chrome strip |
| `src-tauri/src/channels/kill.rs` | taskkill tree on shutdown |
| `src-tauri/src/channels/vault_detector.rs` | %APPDATA% Obsidian vault reader |
| `src-tauri/src/tokens/record.rs` | TokenRecord struct |
| `src-tauri/src/tokens/walker.rs` | ~/.claude JSONL traversal |
| `src-tauri/src/tokens/aggregate.rs` | Per-session aggregation |
| `src-tauri/src/tokens/backfill.rs` | backfill_transcripts command body |
| `src-tauri/src/tokens/live.rs` | active_sessions live polling |
| `src-tauri/src/settings/store.rs` | Load/save user settings |
| `src-tauri/src/settings/overrides.rs` | Per-project notif overrides |
| `src-tauri/src/settings/paths.rs` | App-data / session / sound-pack paths |
| `src-tauri/src/notifications/rules.rs` | Event rule resolution + firing |
| `src-tauri/src/notifications/soundpacks.rs` | Pack catalog + install |
| `src-tauri/src/notifications/audio.rs` | Audio playback queue |
| `src-tauri/src/notifications/piper.rs` | Piper TTS integration |
| `src-tauri/src/ipc/usage.rs` | Usage + poll commands |
| `src-tauri/src/ipc/settings.rs` | Settings get/save commands |
| `src-tauri/src/ipc/projects.rs` | Project ops commands |
| `src-tauri/src/ipc/channels.rs` | Channel spawn/stop commands |
| `src-tauri/src/ipc/tokens.rs` | Token history + backfill commands |
| `src-tauri/src/ipc/auth.rs` | Auth status + login/logout |
| `src-tauri/src/ipc/misc.rs` | Dashboard open/close, log read, quit |
| `src-tauri/src/types/usage.rs` | Usage-related structs |
| `src-tauri/src/types/project.rs` | Project-related structs |
| `src-tauri/src/types/automation.rs` | Automation config, InstanceKind |
| `src-tauri/src/types/notifications.rs` | Notif event kinds + overrides |
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

`scraping/client.rs` uses a CDP-driven hidden Chrome tab rather than a direct HTTP
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

Generated at runtime as a 22x22 RGBA PNG. Rendered in `src-tauri/src/tray/icon_render.rs`.

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
`notifications::resolve_notif_config` (`src-tauri/src/notifications/rules.rs`). Sound files
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

- `src-tauri/src/hooks/instances.rs` — in-memory registry keyed by `session_id`. Emits `instances-changed` Tauri events on every mutation.
- `src-tauri/src/hooks/server.rs` — `/hooks/session-start` and `/hooks/session-end` endpoints populate the registry.
- `src-tauri/src/hooks/detector.rs` — 5s reconciliation loop using `sysinfo`. Marks instances as ended after 2 consecutive missing-pid ticks.
- `src-tauri/src/hooks/session_files.rs` — resolves `bridgeSessionId` from `~/.claude/sessions/<pid>.json` for phone-link URLs.
- `src-tauri/src/hooks/installer.rs` — merges our SessionStart/SessionEnd entries into `~/.claude/settings.json`. Preserves every unrelated field, idempotent.
- First-run modal in `dashboard.html` asks the user to allow the global hook install; "Never" button declines permanently.
- Project cards on the Projects view surface live-instance count and remote/automated tags.
- Running-instances list on the Project detail view shows per-instance actions. Terminal/restart/stop are automated-only; phone-link requires a resolved `bridgeSessionId`.

## Channel management (Plan C)

- `src-tauri/src/channels/` owns automated channel lifecycle: spawn, kill tree, restart-with-backoff, show/hide console. Windows-only.
- Spawn uses raw `CreateProcessW` with `STARTF_USESHOWWINDOW | SW_HIDE` in `STARTUPINFOW` so the new console is born invisible (no flash) and `CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP`. Command line: `cmd.exe /C claude --remote-control --remote-control-session-name-prefix "<prefix>" [--continue]`.
- After spawn, hwnd resolved via `EnumWindows` by owning pid, then `strip_console_chrome` removes `WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_THICKFRAME` so the console is frameless when shown. No X button: user can't kill the process by closing the window; only the dashboard's Stop action does. Hide/Stop/Restart live in the Project detail view.
- Watchdog blocks on `WaitForSingleObject` via `tokio::task::spawn_blocking` (SpawnOutput now exposes a raw `process_handle: isize`, no tokio `Child`). Drives `next_restart_delay` (stable >5s → immediate restart; early exit → 2/4/8/16s backoff; 5 cap-bucket failures → Crashed).
- Kill on shutdown uses `taskkill /T /F /PID <pid>` — claude spawns node subprocesses so tree-kill is required.
- `src-tauri/src/channels/vault_detector.rs` reads `%APPDATA%\Obsidian\obsidian.json` for the automation picker.
- `ipc::import_legacy_obsidian_config` maps the old Python app's config.json into a new ProjectConfig with an auto-configured automation.
- The `obsidian_claude_remote` repo is archived on GitHub as of 2026-04-21; see its README.
