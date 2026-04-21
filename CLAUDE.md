# Claude AI Usage Toolbar

Windows system tray app (Tauri 2) that monitors Claude AI usage by scraping
the Claude settings/usage page via a CDP-driven hidden Chrome tab, once per
hour. macOS + Linux builds deferred.

## Running

```bash
cargo tauri dev
```

Production build:

```bash
cargo tauri build
```

Requires Rust toolchain at `~/.cargo/bin` + Tauri CLI v2 (`cargo install tauri-cli --version "^2.0"`).

## Architecture

**Single Rust binary + static webview assets.** Rust owns tray, scraping,
scheduling, IPC, notifications. Webview serves the dashboard as a tiny SPA.

| File | Role |
|---|---|
| `src/main.rs` | App entry - builds Tauri app, wires plugins, kicks off scheduler |
| `src/lib.rs` | Module root |
| `src/auth.rs` | Native browser sign-in - spawns Chrome with CDP, extracts sessionKey |
| `src/cdp.rs` | Chrome DevTools Protocol client (WebSocket, Fetch domain) |
| `src/scraper.rs` | Fetches usage JSON via hidden Chrome tab + CDP Fetch interception |
| `src/session.rs` | Loads/saves sessionKey cookie, verifies it against the API |
| `src/scheduler.rs` | Hourly poll loop, retry/backoff, triggers tray updates |
| `src/hook_server.rs` | HTTP hook server for Claude Code stop/notify hooks |
| `src/ipc.rs` | Tauri command handlers exposed to the webview |
| `src/state.rs` | Shared app state across threads |
| `src/tray.rs` | Tray icon menu, display mode cycling, threshold checking |
| `src/icon.rs` | Tray icon rendering (rings; Bars + Digits + spin anim pending) |
| `src/icon_settings.rs` | Icon color/threshold logic |
| `src/display_state.rs` | Tracks which display mode is currently shown |
| `src/fonts.rs` | Pixel font definitions for future Digits mode |
| `src/usage_parser.rs` | Parses `five_hour` / `seven_day` fields from API response |
| `src/history.rs` | Snapshot persistence (history.jsonl read/write/prune) |
| `src/settings.rs` | Load/save user settings to disk |
| `src/paths.rs` | App data / session / sound-pack / piper path helpers |
| `src/notifications.rs` | Notification rule resolution + event firing + mute gating |
| `src/project_overrides.rs` | Per-project notification override parser |
| `src/soundpacks.rs` | Sound pack catalog, install (download+unzip), path resolution |
| `src/audio.rs` | Base64 data URL serving of pack audio files to the webview |
| `src/piper.rs` | Piper TTS integration (binary resolution; port WIP) |
| `src/token_stats.rs` | Token stats scaffolding (JSONL walker pending) |
| `src/types.rs` | Shared data structures |
| `dist/dashboard.html` | Dashboard + settings UI (single-file SPA) |
| `dist/dashboard.css` | Dashboard styles |
| `dist/dashboard.js` | Dashboard renderer logic |
| `dist/modules/*.js` | Chart, formatters, settings, sound-packs, stats, speech-fallback |
| `capabilities/default.json` | Tauri 2 IPC permission allowlist |
| `icons/` | Build-time tray + installer icons (committed; regenerate via `cargo tauri icon <source.png>` if logo changes) |
| `assets/` | Bundled fonts + default notification sounds |
| `binaries/piper/` | Sidecar Piper TTS binary (per-target-triple name) |
| `tauri.conf.json` | Tauri config - bundle, updater, windows, frontend path |
| `Cargo.toml` | Rust deps |
| `build.rs` | Build-time asset/icon checks |

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

Generated at runtime as a 22x22 RGBA PNG. Rendered in `src/icon.rs`.

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
`notifications::resolve_notif_config` (`src/notifications.rs`). Sound files
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
