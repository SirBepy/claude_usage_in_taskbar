# Tauri MVP rewrite - design

**Date:** 2026-04-19
**Status:** Approved - ready for implementation planning
**Supersedes:** nothing (Electron app continues in parallel)

## Goal

Rewrite the Claude Usage Taskbar Tool from Electron + Node.js to Tauri 2.x +
Rust, delivering a v1 "MVP spike" that proves the stack works on Windows
before any further investment. Electron app keeps shipping from `master`
throughout; the Tauri version lives side-by-side in a new `tauri/` folder.

## Motivation

Current Electron app: ~150 MB installer, 150-300 MB idle RAM, ~677 MB
`node_modules`. The usage scrape no longer needs a headless browser (confirmed
2026-04-18: plain Node `fetch` with captured `sessionKey` cookie returns a
valid 200 response - see `scripts/test-direct-api-mvp.js` and
`scripts/test-cookie-minimization.js`). The only time a browser is needed is
the ~monthly login flow, which can be handled by spawning the user's Chrome
with CDP and extracting `sessionKey` in a few seconds.

With the headless browser dropped, the entire Electron runtime becomes
overhead for what is otherwise a tray icon + one HTTPS request per hour + a
dashboard window. Tauri 2.x gives us a ~3-10 MB installer, ~40-80 MB idle
RAM, system webview for the existing HTML dashboard, and first-class
libraries for tray, auto-update, and autostart.

## Scope

### In scope (MVP v1, Windows only)

1. Tray icon with dual concentric progress rings (5-hour + 7-day usage),
   rendered as a 22x22 PNG at runtime.
2. Tray context menu: Open Dashboard, Refresh Now, Quit.
3. Hourly background poll of `/api/organizations/<uuid>/usage` via `reqwest`
   with the stored `sessionKey` cookie.
4. Login flow: spawn Chrome with `--remote-debugging-port` and a fresh
   profile, wait for login, extract `sessionKey` via CDP
   `Storage.getCookies`, close Chrome. Runs on first launch and when an
   existing `sessionKey` fails.
5. Local HTTP hook server (axum) on an ephemeral port, receives stop/notify
   pings from Claude Code CLI.
6. Dashboard window: ports the existing HTML/CSS/JS with mild cleanup,
   rewires IPC from `window.electron.*` to Tauri `invoke()`.
7. Settings persistence (JSON file in `%APPDATA%\claude-usage-tauri`).
8. History persistence (append-only JSONL, pruned >90 days old).
9. Autostart on boot via `tauri-plugin-autostart`.
10. Auto-update from GitHub releases via `tauri-plugin-updater`.
11. NSIS installer via `cargo tauri build`.

### Out of scope (MVP v1)

- macOS build (post-MVP).
- Linux build (post-MVP).
- Sync backend integration (permanently dropped - `server/` stays as-is for
  existing Electron users but the Tauri app is local-only).
- Piper TTS + voice notifications (post-MVP).
- Token-stats JSONL walker for `~/.claude/projects/` (post-MVP).
- Removal of the Electron app during MVP (runs in parallel until Tauri
  reaches feature parity; see "Cutover" section below for retirement plan).

## Architecture

Balanced split: Rust owns business logic; JS is a passive view.

```
+-----------------------------------------------------+
| Tauri binary  (Windows MVP, ~8 MB installer)        |
+-----------------------------------------------------+
| Rust backend  (~1500 LOC target)                    |
|   tray   scheduler   scraper   auth   cdp           |
|   history   settings   hook_server   ipc            |
+-----------------------------------------------------+
| Webview  (dashboard.html ported)                    |
|   Thin JS: calls invoke(), renders emitted events   |
+-----------------------------------------------------+

Disk: %APPDATA%\claude-usage-tauri\
  settings.json
  history.jsonl
  session.txt
```

### Key crates

| Crate | Purpose |
|---|---|
| `tauri` 2.x | App framework, tray, webview, IPC |
| `tauri-plugin-autostart` | Launch on boot |
| `tauri-plugin-updater` | Auto-update from GitHub releases |
| `tauri-plugin-log` | Structured logs to disk |
| `reqwest` (cookies + json) | HTTPS poll |
| `tokio-tungstenite` | CDP WebSocket client for login |
| `axum` | Local hook HTTP server |
| `serde` + `serde_json` | JSON + on-disk structs |
| `image` | PNG byte generation for tray icon |

### File layout

```
/claude_usage_in_taskbar
|-- main.js, src/, package.json       (existing Electron - untouched)
|-- server/, mcp-server/              (untouched)
`-- tauri/                            (NEW)
    |-- Cargo.toml
    |-- tauri.conf.json
    |-- src/
    |   |-- main.rs          Tauri setup, plugin registration, invoke registry
    |   |-- tray.rs          Tray icon + context menu
    |   |-- icon.rs          PNG byte generation (port of current icon.js)
    |   |-- scheduler.rs     tokio interval task (hourly poll)
    |   |-- scraper.rs       reqwest GET /api/organizations/<id>/usage
    |   |-- auth.rs          Chrome spawn + CDP cookie extraction
    |   |-- cdp.rs           Minimal CDP WebSocket client
    |   |-- history.rs       Snapshot load/save/merge/prune
    |   |-- settings.rs      Settings JSON load/save
    |   |-- hook_server.rs   axum HTTP server on ephemeral port
    |   |-- ipc.rs           #[tauri::command] handlers + event emits
    |   `-- types.rs         UsageSnapshot, Settings, AuthState, etc
    `-- dist/                Webview assets
        |-- dashboard.html   Ported from src/renderer/
        |-- dashboard.css    Ported
        |-- dashboard.js     Ported + IPC rewired
        `-- modules/
            |-- formatters.js
            `-- chart.js
```

### Module map (current JS -> new Rust)

| Current file | New Rust module | Notes |
|---|---|---|
| `src/core/tray.js` | `tray.rs` | Uses `tauri::tray::TrayIconBuilder` |
| `src/core/icon.js` + `png-utils.js` + `fonts.js` | `icon.rs` | Use `image` crate for PNG encoding |
| `src/core/scraper.js` (Electron + CDP) | `scraper.rs` | Plain `reqwest` - the biggest simplification |
| `src/core/native-auth.js` | `auth.rs` + `cdp.rs` | Chrome spawn + CDP WebSocket |
| `src/core/history.js` | `history.rs` | JSONL load/save/prune |
| `src/core/settings.js` | `settings.rs` | JSON load/save |
| `src/core/hook-server.js` | `hook_server.rs` | axum listener |
| `src/core/updater.js` | (plugin) | `tauri-plugin-updater` handles it |
| `src/core/usage-parser.js` | `types.rs` | `#[derive(Deserialize)]` |
| `src/core/session.js` | deleted | Cookie lives in `reqwest` + `session.txt` |
| `src/core/windows.js` | deleted | Old Electron fallback, not ported |
| `src/renderer/*` | `tauri/dist/*` | Ported as-is, IPC rewired |

## IPC surface

### JS -> Rust (`invoke`)

| Command | Args | Returns | Purpose |
|---|---|---|---|
| `get_current_usage` | - | `Option<UsageSnapshot>` | Latest poll result |
| `get_history` | `{ limit: u32 }` | `Vec<UsageSnapshot>` | Chart data |
| `poll_now` | - | `Result<UsageSnapshot, String>` | Manual refresh |
| `get_settings` | - | `Settings` | Settings panel |
| `save_settings` | `Settings` | `Result<(), String>` | Persist changes |
| `start_login` | - | `Result<(), String>` | Trigger Chrome+CDP flow |
| `auth_status` | - | `AuthState` | `LoggedIn` / `NeedsLogin` / `InProgress` |
| `open_dashboard` | - | `()` | Show dashboard window |
| `quit_app` | - | `()` | Tray menu "Quit" |

### Rust -> JS (events via `emit_all`)

| Event | Payload | When |
|---|---|---|
| `usage-updated` | `UsageSnapshot` | After successful poll |
| `poll-failed` | `{ reason: String }` | After failed poll |
| `auth-progress` | `{ stage: String }` | Login stages: `waiting-for-browser`, `waiting-for-user`, `extracting`, `done` |
| `settings-changed` | `Settings` | After save |

## Data model

```rust
// types.rs

#[derive(Serialize, Deserialize, Clone)]
struct UsageSnapshot {
    captured_at: String,          // ISO8601
    five_hour: WindowUsage,
    seven_day: WindowUsage,
    extra_usage: Option<ExtraUsage>,
}

#[derive(Serialize, Deserialize, Clone)]
struct WindowUsage { utilization: f64, resets_at: String }

#[derive(Serialize, Deserialize, Clone)]
struct ExtraUsage {
    is_enabled: bool,
    monthly_limit: u32,
    used_credits: u32,
    utilization: f64,
    currency: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct Settings {
    poll_interval_secs: u64,      // default 3600
    display_mode: DisplayMode,    // Rings / Bars / Digits
    threshold_warn: f64,          // default 50.0
    threshold_crit: f64,          // default 80.0
    autostart: bool,              // default true
    hook_port: Option<u16>,       // written by hook_server on startup
}

#[derive(Serialize, Deserialize, Clone)]
enum AuthState { LoggedIn, NeedsLogin, InProgress }

#[derive(Serialize, Deserialize, Clone)]
enum DisplayMode { Rings, Bars, Digits }
```

### On-disk layout

```
%APPDATA%\claude-usage-tauri\
|-- settings.json       Single Settings struct
|-- history.jsonl       One UsageSnapshot per line, append-only, pruned >90d
`-- session.txt         Raw sessionKey cookie value (single line)
```

## Error handling

- Poll failures are logged and emitted as `poll-failed`; the scheduler
  continues on its interval. After 3 consecutive 401/403 results the app
  emits `auth-progress { stage: "NeedsLogin" }` and the tray icon switches
  to a "needs login" state.
- Login flow failures (Chrome not found, timeout, CDP error) surface as a
  `start_login` rejection with a human-readable reason. The dashboard shows
  the reason and offers retry.
- History file corruption: on parse error, the bad line is skipped and
  logged; polling continues.
- Settings file corruption: fall back to defaults and rewrite the file.
- Hook server port-in-use: pick a different ephemeral port and update
  `settings.hook_port`.

## Testing

- `scraper` - unit test against a mock HTTP server (no network).
- `history` - unit tests for load/save/prune round-trips on a temp dir.
- `settings` - unit tests for load/default/save round-trips.
- `icon` - snapshot tests: feed known inputs, compare PNG bytes against
  committed golden files.
- `auth` + `cdp` - manual end-to-end test only; too expensive to mock
  reliably. Covered by the existing `scripts/test-direct-api-mvp.js` flow.
- `hook_server` - unit test that axum accepts a POST and updates state.

No Rust integration tests that spawn a real browser in CI.

## Phasing (order of work)

Each step ships green (compiles, runs, observable) before the next begins.

1. **Scaffold** `tauri/` via `cargo tauri init`. Commit an empty app that
   opens a blank window from the tray.
2. **Tray + icon.** Render dual-ring PNG with hardcoded percentages. Menu
   with Quit.
3. **Scraper + types.** Hardcoded cookie in dev env, fetch and parse usage
   JSON, print to stdout. Proves `reqwest` works end-to-end.
4. **Session file + settings.** Load/save both; scraper reads cookie from
   `session.txt`.
5. **Scheduler.** `tokio` interval task that polls on the configured
   interval, appends to `history.jsonl`, emits `usage-updated`.
6. **Dashboard port.** Copy HTML/CSS/JS to `dist/`, rewire `invoke()`
   calls, subscribe to `usage-updated` event.
7. **Login flow.** Port `auth.rs` + `cdp.rs`, spawn Chrome, extract
   `sessionKey`, write to `session.txt`. First-launch + 401 recovery.
8. **Hook server.** `axum` listener on ephemeral port; writes port to
   settings; handles incoming Claude Code stop/notify pings. Tray spin
   animation on ping (parity with current Electron behavior).
9. **Autostart + updater.** Wire `tauri-plugin-autostart` and
   `tauri-plugin-updater` with the existing GitHub releases repo.
10. **Installer.** `cargo tauri build` -> NSIS; add GitHub Actions release
    workflow (or reuse the existing one).

Steps 1-5 = polling proof. Steps 6-10 = feature parity with the current
Electron MVP path.

## Open questions (resolved)

- Scope: MVP spike (not full port).
- Architecture: Balanced (Rust owns logic, JS is view).
- Repo: Sibling `tauri/` folder in same repo.
- Target OS: Windows only for v1.
- Dashboard: Port existing HTML + mild cleanup.
- Cuts: Sync backend (permanent). Piper TTS + token-stats JSONL walker
  deferred to v2. Hook server stays in MVP scope.

## Risks

1. **WebView2 runtime on ancient Win10 builds** - Tauri installer's
   bootstrapper handles this. +~2 MB installer cost. Acceptable.
2. **Tauri 2.x API churn** - v2 went stable in 2024 but minor-version
   breakage has happened. Pin exact versions in `Cargo.toml`.
3. **CDP WebSocket client maintained by hand** - the one in the MVP script
   is ~60 LOC of `WebSocket.send`/`receive`; porting to
   `tokio-tungstenite` should be straightforward. If it bloats, reach for a
   `chromiumoxide`-style crate.
4. **Rust beginner learning curve** - mitigated by the "balanced" split
   being mostly struct parsing, HTTP calls, and file IO (all low-borrow
   territory). Async is isolated to `scheduler`, `scraper`, `auth`,
   `hook_server`.

## Success criteria

- `cargo tauri build` on Windows produces an NSIS installer <15 MB.
- Installed app idles at <80 MB RAM with tray visible.
- After login, hourly polls succeed for 7 consecutive days without
  intervention.
- Dashboard renders the same charts as the Electron version.
- `tauri-plugin-updater` can pull a new release from GitHub and apply it.

Failure to hit any of these means the MVP is re-evaluated before v2 work
starts.

## Cutover (Electron retirement)

Once the Tauri app reaches feature parity with the Electron app for the
owner's daily use and has run for at least two weeks without a regression
that forced a fallback to Electron, the Electron code is retired from
`master`. Until then, nothing described in this section happens.

### Trigger conditions (all must hold)

1. Tauri version handles: tray rings, hourly poll, login flow, dashboard,
   hook server, auto-update, autostart.
2. Feature parity reached for any v2 items the owner actually uses
   (e.g. piper TTS, token stats) if those ship before cutover.
3. Two weeks of daily use on the owner's Windows machine with no
   unresolved bug that required running the Electron app instead.

### Retirement steps

1. Tag current `master` as `electron-final` and push to origin as a
   long-lived archival branch `electron-archive`. This is the preservation
   artifact: the last working Electron state is always recoverable.
2. Delete from `master`:
   - `main.js`
   - `src/` (Electron source)
   - `scripts/download-piper.js`, `scripts/generate-icons.js`,
     `scripts/aiusage-hook.ps1`, `scripts/aiusage-hook.sh`
   - `resources/` (piper binaries)
   - `build/` (NSIS extras)
   - `package.json`, `package-lock.json`, `node_modules/` (via .gitignore)
   - Any Electron-only entries in `.github/workflows/*`
3. Promote `tauri/` contents to the repo root: move `tauri/Cargo.toml`,
   `tauri/src/`, `tauri/dist/`, `tauri/tauri.conf.json` up one level,
   delete the empty `tauri/` dir.
4. Keep untouched: `server/`, `mcp-server/`, `docs/`, `scripts/test-*.js`
   (useful as regression harnesses), `LICENSE`, `.github/ISSUE_TEMPLATE/`.
5. Rewrite `README.md` for the Tauri stack (install, build, architecture).
6. Rewrite `CLAUDE.md` to describe the Rust module layout; remove the
   Electron architecture table.
7. Update `.github/workflows/release.yml` (or equivalent) to run
   `cargo tauri build` and publish NSIS installer to the same
   `SirBepy/claude_usage_in_taskbar` release pipeline. Old Electron
   releases stay attached to their tags; new releases are Tauri-only.
8. Bump to `v2.0.0` for the first post-cutover release to signal the
   breaking stack change to downstream tooling.

### Existing-user migration

- `electron-updater` in the Electron app pulls from the same GitHub
  releases. If a Tauri release ships under the same repo with an artifact
  name `electron-updater` does not recognize, it will fail quietly rather
  than upgrade an Electron user to a Tauri binary (mismatched formats).
- To force existing Electron users to upgrade, ship one last Electron
  release (`v1.x.y`) whose only behavior is a dialog instructing the user
  to download the new Tauri installer from the releases page, and then
  exits. This avoids half-upgraded states where Electron keeps running
  alongside a Tauri install.
- Settings + history files live at different paths
  (`claude-usage-tauri` vs the Electron app's path). A one-time migration
  routine in the Tauri app's first launch can import from the Electron
  path if it exists. Low priority; defer unless the owner asks.
