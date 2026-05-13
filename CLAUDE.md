@~/.claude/snippets/auto-commit.md

# Claude Companion (formerly Claude AI Usage Toolbar)

Cross-platform Tauri 2 app for Claude Code users. Originally a usage tracker;
now combines:

- **Usage monitoring** (5h / 7d windows) via CDP-driven hidden Chrome scraping.
- **Sessions view** that owns interactive Claude chat sessions across the
  user's projects via per-turn `claude -p --resume <id>` invocations
  (Path C; spawned via std::process::Command, no PTY).
- **Custom HTML chat renderer** with markdown (markdown-it), syntax-highlighted
  code blocks (shiki, github-dark), and clipboard image paste.
- **History view** for read-only browsing of past sessions from
  `~/.claude/sessions/*.jsonl`.
- **Manual session takeover**: kill an external `claude` process and resume
  its session from this app.
- **Detachable session windows**: pop a session into its own Tauri window.
- **Hooks system** surfacing live instance state across all session kinds
  (External / Automated / Remote / Interactive).

Windows, macOS, and Linux (x86_64 DEB + AppImage) supported. Linux gets the
chat hub but not the future character-overlay work (Wayland click-through gap).

## Chat hub (Path C architecture)

Each user turn = one short-lived `claude -p --resume <session_id>
--output-format=stream-json --verbose --include-partial-messages` process.
`std::process::Command` pipes stdout, lines stream through `chat::parser` to
emit `ChatEvent`s, claude exits when the turn completes. Cancel during a
turn via `cancel_turn` IPC -> `kill_tree(pid)` on the runner's child.

**Billing.** Spawned `claude -p` inherits the user's auth from the
[Claude Code auth precedence](https://code.claude.com/docs/en/authentication):
`ANTHROPIC_API_KEY` > `apiKeyHelper` > `CLAUDE_CODE_OAUTH_TOKEN` > Bedrock/Vertex
envs > `/login` OAuth. With none of those set, billing falls through to the
existing Pro/Max subscription quota (same pool as a normal interactive `claude`
session). The `total_cost_usd` field in `result` events is a local API-rate
*estimate*, NOT an actual charge; per the docs, "the dollar figure is an estimate
computed locally from token counts and may differ from your actual bill."

`chat/runner.rs::check_metered_billing` refuses to spawn if `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, or `CLAUDE_CODE_USE_VERTEX`
is set. The chat hub is subscription-only by design; metered operation is not
supported.

**Rejected: Agent SDK pivot.** `@anthropic-ai/claude-agent-sdk` and the Python
equivalent explicitly require `ANTHROPIC_API_KEY` and route to the metered API
(per [Agent SDK docs](https://code.claude.com/docs/en/agent-sdk/overview):
*"Anthropic does not allow third party developers to offer claude.ai login or
rate limits for their products, including agents built on the Claude Agent
SDK."*). Not a viable path for this app.

Key modules:
- `src-tauri/src/chat/runner.rs` - per-turn process spawn, stdout pump,
  stderr-drain thread, cancel-via-pid slot.
- `src-tauri/src/chat/parser.rs` - line-delimited stream-json -> ChatEvent.
  Buffers across read boundaries, handles CRLF.
- `src-tauri/src/chat/takeover.rs` - external -> Interactive promotion:
  resolve session_id via `~/.claude/sessions/<pid>.json`, kill_tree the
  external process, register Interactive entry preserving project_id + pid.
- `src-tauri/src/chat/history.rs` - JSONL replay (reuses parser).
- `src-tauri/src/ipc/chat.rs` - start_session / send_message / cancel_turn /
  paste_image / takeover_manual / load_history / list_history /
  detach_window / reattach_window / cancel_all_inflight_turns (quit hook) /
  gc_attachments (24h scheduler) / respond_permission / respond_question.
- `src-tauri/src/mcp/server.rs` - stdio MCP server (permission-prompt + ask_user_question tools).
- `src-tauri/src/sessions/registry.rs` - Instance registry (was
  hooks/instances.rs); gained busy bool + record_interactive_session +
  upsert_interactive + set_busy helpers.
- `src/views/sessions/sessions.ts` - main Sessions view + renderDetachedSession.
- `src/views/sessions/permission-modal.ts` - permission / question relay modal (permission-requested + question-requested Tauri events).
- `src/views/history/history.ts` - History view orchestration.
- `src/shared/chat/chat-renderer.ts` - virtualized DOM rendering, markdown
  + shiki post-pass.
- `src/shared/chat/composer.ts` - textarea + image paste, mountId race
  guard pattern, "image attachment dropped" surfaced visibly when
  paste_image IPC unavailable (memory rule: don't silently drop).

Image paste flow: composer captures `image/*` from clipboard -> POSTs base64
to `paste_image` IPC -> Rust validates session_id (alphanumeric+dash+underscore,
length-capped) -> writes to `<app-data>/chat-attachments/<sid>/<uuid>.<ext>`
-> returns path -> composer pushes `<file:<path>>` mention text into the
next turn's prompt. Claude reads the file via its Read tool. Attachments
older than 30 days GC'd by a background task scheduled at app startup.

The original "tray-app monitors usage" identity is intact; the chat hub
ships alongside, sharing the existing tray + dashboard window.

## Chat hub permissions

When the runner spawns `claude -p`, it also:
1. Writes a per-turn `.mcp.json` to `<app-data>/mcp/<turn-uuid>.json` containing
   the path to the current executable and `--mcp-permission` as the command.
2. Passes `--permission-prompt-tool mcp__cc_companion__approval_prompt` and
   `--mcp-config <path>` to the `claude` command.

When claude needs permission to run a tool (Edit, Write, Bash, …) it calls
`mcp__cc_companion__approval_prompt` on our MCP server subprocess. The MCP
server HTTP-POSTs to `/permissions/request` on the hooks server (port from
`<app-data>/hooks_port.txt`). The hooks server inserts a oneshot channel into
`AppState::pending` and emits the Tauri event `permission-requested`. The
sessions view shows a modal; the user clicks Allow or Deny, which fires the
`respond_permission` IPC → resolves the pending channel → HTTP response
returns to the MCP server → claude proceeds.

`AskUserQuestion` uses the same pipeline via `/questions/request` and
`respond_question`. When the stream-json shows a `tool_use` with name
`AskUserQuestion` or ending in `ask_user_question`, the chat renderer
renders the questions inline (read-only display); the interactive question
modal fires from the `question-requested` Tauri event.

**Debugging:**
- Port: `cat <app-data>/hooks_port.txt`
- MCP server stderr: captured by runner's stderr-drain thread and included
  in `RunError::NonZeroExit.stderr` on failure.
- Pending map leaks: each request times out after 5 minutes server-side.

**Key files:**
- `src-tauri/src/mcp/server.rs` — stdio JSON-RPC 2.0 MCP server
- `src-tauri/src/hooks/server.rs` — `/permissions/request|respond` + `/questions/request|respond` endpoints + pending map
- `src/views/sessions/permission-modal.ts` — permission + question modal UI

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

| File                                        | Role                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `src-tauri/src/main.rs`                     | App entry - builds Tauri app, wires plugins, kicks off scheduler                                              |
| `src-tauri/src/lib.rs`                      | Module declarations + run()                                                                                   |
| `src-tauri/src/state.rs`                    | Shared AppState                                                                                               |
| `src-tauri/src/scheduler.rs`                | Hourly poll loop                                                                                              |
| `src-tauri/src/history.rs`                  | Snapshot persistence                                                                                          |
| `src-tauri/src/auth/session.rs`             | Load/save sessionKey, verify against API                                                                      |
| `src-tauri/src/auth/login_flow.rs`          | Chrome CDP sign-in spawn                                                                                      |
| `src-tauri/src/auth/cdp.rs`                 | CDP WebSocket client                                                                                          |
| `src-tauri/src/scraping/client.rs`          | Hidden-tab Fetch-domain scraper                                                                               |
| `src-tauri/src/scraping/parser.rs`          | five_hour/seven_day JSON parsing                                                                              |
| `src-tauri/src/tray/menu.rs`                | Tray icon menu + threshold check                                                                              |
| `src-tauri/src/tray/icon_render.rs`         | RGBA PNG rendering                                                                                            |
| `src-tauri/src/tray/threshold.rs`           | Icon colour/threshold logic                                                                                   |
| `src-tauri/src/tray/display_mode.rs`        | Display-mode cycling                                                                                          |
| `src-tauri/src/tray/fonts.rs`               | Pixel font defs                                                                                               |
| `src-tauri/src/hooks/server.rs`             | Claude Code stop/notify HTTP hooks                                                                            |
| `src-tauri/src/hooks/installer.rs`          | ~/.claude/settings.json merge                                                                                 |
| `src-tauri/src/hooks/instances.rs`          | Running-instance registry                                                                                     |
| `src-tauri/src/hooks/detector.rs`           | 5 s reconcile loop                                                                                            |
| `src-tauri/src/hooks/session_files.rs`      | ~/.claude/sessions/<pid>.json resolver                                                                        |
| `src-tauri/src/mcp/server.rs`               | stdio MCP server (--mcp-permission mode): approval_prompt + ask_user_question tools                           |
| `src-tauri/src/channels/spawn.rs`           | CreateProcessW automation launcher                                                                            |
| `src-tauri/src/channels/window_chrome.rs`   | hwnd discovery + chrome strip                                                                                 |
| `src-tauri/src/channels/kill.rs`            | taskkill tree on shutdown                                                                                     |
| `src-tauri/src/channels/vault_detector.rs`  | %APPDATA% Obsidian vault reader                                                                               |
| `src-tauri/src/tokens/record.rs`            | TokenRecord struct                                                                                            |
| `src-tauri/src/tokens/walker.rs`            | ~/.claude JSONL traversal                                                                                     |
| `src-tauri/src/tokens/aggregate.rs`         | Per-session aggregation                                                                                       |
| `src-tauri/src/tokens/backfill.rs`          | backfill_transcripts command body                                                                             |
| `src-tauri/src/tokens/live.rs`              | active_sessions live polling                                                                                  |
| `src-tauri/src/settings/store.rs`           | Load/save user settings + `project_key` (repo-root identity)                                                  |
| `src-tauri/src/settings/overrides.rs`       | Per-project notif overrides                                                                                   |
| `src-tauri/src/settings/paths.rs`           | App-data / session / sound-pack paths                                                                         |
| `src-tauri/src/notifications/rules.rs`      | Event rule resolution + firing                                                                                |
| `src-tauri/src/notifications/soundpacks.rs` | Pack catalog + install                                                                                        |
| `src-tauri/src/notifications/audio.rs`      | Audio playback queue                                                                                          |
| `src-tauri/src/notifications/piper.rs`      | Piper TTS integration                                                                                         |
| `src-tauri/src/ipc/usage.rs`                | Usage + poll commands                                                                                         |
| `src-tauri/src/ipc/settings.rs`             | Settings get/save commands                                                                                    |
| `src-tauri/src/ipc/projects.rs`             | Project ops commands + `list_project_groups` (single-source dashboard list, keyed by git-repo-root)           |
| `src-tauri/src/ipc/channels.rs`             | Channel spawn/stop commands                                                                                   |
| `src-tauri/src/ipc/tokens.rs`               | Token history + backfill commands                                                                             |
| `src-tauri/src/ipc/auth.rs`                 | Auth status + login/logout                                                                                    |
| `src-tauri/src/ipc/misc.rs`                 | Dashboard open/close, log read, quit                                                                          |
| `src-tauri/src/types/usage.rs`              | Usage-related structs                                                                                         |
| `src-tauri/src/types/project.rs`            | Project-related structs                                                                                       |
| `src-tauri/src/types/automation.rs`         | Automation config, InstanceKind                                                                               |
| `src-tauri/src/types/notifications.rs`      | Notif event kinds + overrides                                                                                 |
| `src/index.html`                            | Dashboard + settings UI (single-file SPA)                                                                     |
| `src/dashboard.css`                         | Dashboard styles                                                                                              |
| `src/dashboard.js`                          | Dashboard renderer logic                                                                                      |
| `src/modules/*.js`                          | Chart, formatters, settings, sound-packs, stats, speech-fallback                                              |
| `src-tauri/capabilities/default.json`       | Tauri 2 IPC permission allowlist                                                                              |
| `src-tauri/icons/`                          | Build-time tray + installer icons (committed; regenerate via `cargo tauri icon <source.png>` if logo changes) |
| `src-tauri/assets/`                         | Bundled fonts + default notification sounds                                                                   |
| `src-tauri/binaries/piper/`                 | Sidecar Piper TTS binary (per-target-triple name)                                                             |
| `src-tauri/tauri.conf.json`                 | Tauri config - bundle, updater, windows, frontend path                                                        |
| `src-tauri/Cargo.toml`                      | Rust deps                                                                                                     |
| `src-tauri/build.rs`                        | Build-time asset/icon checks                                                                                  |

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
  "extra_usage": {
    "is_enabled": false,
    "used_credits": 0.0,
    "monthly_limit": 0.0
  }
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

| Package                              | Why                                        |
| ------------------------------------ | ------------------------------------------ |
| `tauri` v2                           | App framework                              |
| `tauri-plugin-updater`               | Auto-update via signed installer           |
| `tauri-plugin-autostart`             | Launch on login                            |
| `reqwest` (with gzip/brotli/deflate) | HTTP client for API + sound-pack downloads |
| `tokio`                              | Async runtime                              |
| `serde` / `serde_json`               | Config + API payload parsing               |
| `zip`                                | Sound pack extraction                      |

**Linux build deps (CI runs `ubuntu-22.04`):** `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `patchelf`, `build-essential`, `libssl-dev`, `libgtk-3-dev`. Channel automation (Plan C) is unavailable on Linux v1: `channels::spawn_child` returns `SpawnError::NonWindows` because the headless-process / window-strip flow has no Linux equivalent yet.

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

- `src-tauri/src/channels/` owns automated channel lifecycle: spawn, kill tree, show/hide console. **No auto-restart on exit** (would register a fresh bridge with the Claude desktop app each time, piling up duplicate entries in the Code sidebar). Mirrors the original `obsidian_claude_remote` behavior: spawn once, stay dead until manual Restart.
- **Windows spawn:** raw `CreateProcessW` with `STARTF_USESHOWWINDOW | SW_HIDE` in `STARTUPINFOW` so the new console is born invisible (no flash) and `CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP`. Command line: `cmd.exe /C claude --remote-control --remote-control-session-name-prefix "<prefix>" [--continue]`. After spawn, hwnd resolved via `EnumWindows` by owning pid, then `strip_console_chrome` removes `WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_THICKFRAME` so the console is frameless when shown. No X button: user can't kill the process by closing the window; only the dashboard's Stop action does. Watchdog blocks on `WaitForSingleObject`. Kill uses `taskkill /T /F /PID <pid>` (node subprocesses → tree-kill required).
- **macOS spawn:** `std::process::Command::new("claude")` with remote-control args, null stdio, and `setsid()` in `pre_exec` so the child becomes its own process-group leader (PGID == PID). No visible console exists, so no hwnd-strip, no Show/Hide UI on mac. Watchdog blocks on `libc::waitpid` via `tokio::task::spawn_blocking`. Kill uses `libc::killpg(pid, SIGKILL)` which reaps every node subprocess that inherited the group.
- `src-tauri/src/channels/vault_detector.rs` reads `%APPDATA%\Obsidian\obsidian.json` on Windows and `~/Library/Application Support/{Obsidian,obsidian}/obsidian.json` on macOS (casing varies by installer version) for the automation picker.
- `ipc::import_legacy_obsidian_config` maps the old Python app's config.json into a new ProjectConfig with an auto-configured automation.
- The `obsidian_claude_remote` repo is archived on GitHub as of 2026-04-21; see its README.
