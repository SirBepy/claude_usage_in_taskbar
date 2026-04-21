# Channel Management Integration — Design

**Date:** 2026-04-21
**Status:** Approved (pending user spec review)
**Author:** Claude + SirBepy

## Summary

Fold the functionality of `obsidian_claude_remote` (a separate Python tray app that keeps a `claude --remote-control` process alive inside an Obsidian vault) into this Tauri app, and generalize it. After shipping, this app owns:

1. Existing usage analytics (unchanged).
2. Live tracking of every running Claude Code instance on the machine, scoped to a project (cwd).
3. Optional per-project *automated channels* — a managed `claude --remote-control` process started at boot, kept alive, with show/hide terminal and phone-link surfacing.

A modest UI redesign accompanies this: a collapsible sidemenu replaces the single-view dashboard, and a new **Projects** screen replaces the former **Token Stats** view. After cutover, `obsidian_claude_remote` is retired and archived.

## Goals

- Parity with `obsidian_claude_remote` for the Obsidian-vault use case.
- Scale beyond one vault: any path can be a project, any project can be automated.
- Live awareness of external Claude Code instances (VSCode terminals, ad-hoc shells) without requiring them to be spawned by this app.
- Foundation for future per-project avatars and desktop-sprite animations.

## Non-goals

- Desktop sprite animations or wave-when-done behaviour (designed-for in data model, not implemented).
- Avatar image upload UI (emoji only in v1; manual image-path accepted).
- macOS/Linux parity (deferred, matches current app posture).
- Attaching to external VSCode integrated terminals (show-terminal remains greyed out for external instances).
- Multiple automations per project.
- Replacing the existing authentication or scraper flows.

## UI changes

### Navigation

Current: single-view dashboard with back/forward navigation into settings subviews. Phone-app-sized window.

New:

- Window width bumped from ~400px to ~520px. User-resizable.
- Persistent burger button top-left of every view.
- Sliding sidemenu overlay (Android-style) with dimming backdrop. 200ms CSS transform.
- Sidemenu items (Phosphor icons, top-to-bottom):
  - **Home**
  - **Statistics**
  - **Projects**
  - **Settings**
- Tap item → navigate, auto-close sidemenu. Tap backdrop or burger → close.
- Sidemenu is not persistent; always starts closed.

### Home view

- Header: burger + "Claude Usage" title.
- Body: the two big cards from today's dashboard (Session 5h and Weekly 7d), stacked. Each shows ring + percent + resets-at subline.
- Every other widget currently sharing that view moves to Statistics.

### Statistics view

One-to-one move of the widgets that currently live on the dashboard but are not the two big cards (pace charts, history chart, extra-usage summary, etc.). No new charts this pass.

### Projects view

- Header: "Projects" title + grid/list toggle button.
- **Grid mode (default):** 2-column CSS grid at 520px width. Each card = avatar | name + tags row | 7d token total.
- **List mode:** vertical rows, same data, more compact. Toggle state persists in `settings.projects_view_mode`.
- Each card shows:
  - Avatar (emoji or placeholder).
  - Name (defaults to path basename; user-editable).
  - 7d token total.
  - Live-instance count badge (`● N`) if any instance currently registered.
  - `📱` icon if any instance is remote-enabled.
  - `⚙` icon if project has an automation configured.
- Card tap → Project detail view.
- Cards sorted by: live-instance count desc, then last-active desc.
- No `+ Automate channel` button on this screen.

### Project detail view

- Header: back button, avatar, name, path (muted, small), three-dot menu (Edit / Delete).
- `+ Automate channel` button right-aligned (or promoted to CTA row if none exists).
- **Running instances block (new, top of body):**
  - Section heading: `Running instances (N)`.
  - One row per live instance:
    - Status dot: green (automated, running), blue (external), grey (recently ended, before removal).
    - Tag chips: `Automated` or `External`, and `📱` if remote.
    - PID · uptime · truncated session id.
    - Action button row: show-terminal · phone-link · restart · stop.
    - Actions disabled with tooltip when not applicable (external → restart/stop/terminal all disabled; phone-link disabled until `bridgeSessionId` resolved).
- Existing detail content below (token history chart, avatar config, automation config when present).

### Settings view

Exactly what exists today; just relocated under the sidemenu Settings item instead of being a back-accessible subview of Home.

## Data model

### Settings additions (`src/settings.rs`)

```rust
struct Settings {
    // ... existing fields unchanged ...
    projects: Vec<ProjectConfig>,
    projects_view_mode: ViewMode,           // Grid | List
    hooks_registered: bool,                 // global ~/.claude/settings.json install completed
    hook_registration_declined: bool,       // user said no at least once
}

struct ProjectConfig {
    id: String,                      // stable uuid; survives path rename
    path: PathBuf,                   // canonical cwd
    name: String,                    // derived from path, user-editable
    avatar: Avatar,                  // Emoji(String) | Image(PathBuf) | None
    automation: Option<AutomationConfig>,
    created_at: DateTime<Utc>,
    last_active_at: Option<DateTime<Utc>>,
}

struct AutomationConfig {
    enabled: bool,
    autostart_on_boot: bool,
    session_name_prefix: Option<String>,    // overrides default = project.name
    continue_flag: bool,                    // default true → --continue
}

enum Avatar {
    Emoji(String),
    Image(PathBuf),
    None,
}

enum ViewMode { Grid, List }
```

Projects are created lazily: the first time a hook payload reports a new cwd, `instances.rs` asks `settings.rs` to upsert a default `ProjectConfig`. The user can then edit it.

### Instance registry (in-memory, `src/instances.rs`)

```rust
struct Instance {
    session_id: String,                  // key
    pid: u32,
    cwd: PathBuf,
    project_id: String,                  // resolved via settings at registration
    kind: InstanceKind,                  // Automated | External
    is_remote: bool,                     // true if remote-control session
    started_at: DateTime<Utc>,
    transcript_path: Option<PathBuf>,
    bridge_session_id: Option<String>,   // filled async by session_files enrichment
    ended_at: Option<DateTime<Utc>>,
    end_reason: Option<EndReason>,       // HookSessionEnd | ProcessGone | ChildExit | Manual
}

enum InstanceKind { Automated, External }
enum EndReason { HookSessionEnd, ProcessGone, ChildExit, Manual }
```

Registry is not persisted. Cold start = empty. Rebuilds via hooks + detector as sessions resume or start. Ended instances are retained for 60 seconds then removed so the UI shows a graceful fade-out without lingering dead rows.

## New Rust modules

- **`src/instances.rs`** — registry keyed by `session_id`. API: `register`, `mark_ended`, `list`, `by_cwd`, `by_project`. Every mutation emits a `instances-changed` Tauri event to the webview. Also calls `settings::upsert_project_for_cwd(cwd)` on registration to lazy-create project configs.

- **`src/channels.rs`** — owns automated channels. `Channel { project_id, child: Child, console_hwnd: Option<isize>, restart_state: RestartState }`. API: `spawn(project_id)`, `stop(project_id)`, `restart(project_id)`, `show_terminal(project_id)`, `hide_terminal(project_id)`, `kill_all()`. On app boot, after auth completes, iterates `projects[*]` and spawns any with `automation.enabled && automation.autostart_on_boot`. On app shutdown, `kill_all()` via `taskkill /T /F /PID <pid>` to catch the node subprocess tree.

- **`src/detector.rs`** — 5-second interval tokio task. Lists processes, reconciles against the registry. For each registered session whose PID has been absent for 2 consecutive ticks, calls `instances::mark_ended(session_id, ProcessGone)`. 30-second grace period after registration so a slow-to-register session-JSON doesn't trigger false positives.

- **`src/hook_installer.rs`** — one-time global hook registration. Flow:
  1. Read `~/.claude/settings.json` (or create empty `{}` if missing).
  2. Parse JSON (bail with surfaced error if malformed; don't touch).
  3. Deep-merge our entries into `hooks.SessionStart` and `hooks.SessionEnd` arrays — preserve any existing hooks exactly.
  4. Write atomically (temp file + rename).
  5. Persist `settings.hooks_registered = true`.
  - First launch surfaces a dashboard modal explaining what will be written and why, with Accept / Not now / Never buttons. "Never" sets `hook_registration_declined = true`.
  - If the local hook server port changes between launches, re-register.

- **`src/session_files.rs`** — helpers to read `~/.claude/sessions/<pid>.json` for `bridgeSessionId`. Polling retry loop (15 × 500ms, same as old app) since claude-code writes this file async. Populates `Instance.bridge_session_id` when resolved.

- **`src/vault_detector.rs`** *(nice-to-have, small)* — reads `%APPDATA%\Obsidian\obsidian.json` and returns the list of configured Obsidian vault paths. Used only as a convenience dropdown in "Automate channel" flow.

## Extensions to existing modules

- **`src/hook_server.rs`** — add `POST /hooks/session-start` and `POST /hooks/session-end` routes. Each deserializes the Claude Code hook payload (`session_id`, `hook_event_name`, `cwd`, `transcript_path`, optional `source` / `reason`), validates origin is localhost, and calls into `instances.rs`.

- **`src/ipc.rs`** — new Tauri commands:
  - `list_projects() -> Vec<ProjectSummary>`
  - `get_project(id) -> ProjectDetail`
  - `update_project(id, patch)`
  - `delete_project(id)` (kills running automation first)
  - `list_instances() -> Vec<InstanceSummary>`
  - `list_instances_for_project(id) -> Vec<InstanceSummary>`
  - `spawn_channel(project_id)`, `stop_channel(project_id)`, `restart_channel(project_id)`
  - `show_terminal(project_id)`, `hide_terminal(project_id)`
  - `phone_link(session_id) -> Option<String>`
  - `register_hooks_globally()`, `skip_hook_registration()`
  - `detect_obsidian_vaults() -> Vec<PathBuf>`
  - `import_legacy_obsidian_config() -> Option<ProjectConfig>`

- **`src/state.rs`** — holds `Arc<Mutex<Settings>>`, `Arc<Instances>`, `Arc<Channels>`.

- **`src/main.rs`** — after auth completes, spawn in this order:
  1. `hook_server` (already present).
  2. `hook_installer` first-run check + modal trigger.
  3. `detector` background task.
  4. `channels::autostart_all()` (spawns any `autostart_on_boot` automations).

## Data flow

### Instance starts (primary path)

```
claude-code process starts anywhere on the machine
  → fires SessionStart hook → POST http://localhost:<port>/hooks/session-start
     → hook_server.rs parses, validates, dispatches
        → instances::register({ session_id, pid, cwd, transcript_path, ... })
           → settings::upsert_project_for_cwd(cwd)    // lazy create
           → session_files::enrich_async(session_id)  // resolves bridge_session_id
           → Tauri emits "instances-changed"
              → webview re-renders affected project card + project detail
```

### Instance ends

Two possible sources, first-wins:

```
SessionEnd hook fires → instances::mark_ended(session_id, HookSessionEnd)
```

or

```
detector sees PID absent 2 consecutive ticks → instances::mark_ended(session_id, ProcessGone)
```

For **automated** channels there is also a third source (more reliable):

```
tokio::process::Child::wait() returns → channels layer → instances::mark_ended(..., ChildExit)
```

The registry treats `mark_ended` as idempotent; redundant calls are no-ops.

### Automated channel spawn (Windows)

```rust
let mut cmd = tokio::process::Command::new("cmd");
cmd.args(["/C", "claude", "--remote-control",
          "--remote-control-session-name-prefix", &prefix,
          "--continue"])
   .current_dir(&project.path)
   .creation_flags(CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP);
let child = cmd.spawn()?;
```

Rationale: `claude` is a `.cmd` shim; direct `Command::new("claude")` fails with `FileNotFoundError`. Shelling through `cmd /C` matches the working Python pattern. `CREATE_NEW_CONSOLE` gives the process its own conhost window, which powers the show-terminal feature.

### Console hwnd resolution + show/hide

- After spawn, poll `EnumWindows` filtering by owning PID — 20 retries × 50ms.
- Once resolved: `ShowWindow(hwnd, SW_HIDE)` immediately. Store hwnd in `Channel`.
- `show_terminal(project_id)` → `ShowWindow(hwnd, SW_SHOW)` + `SetForegroundWindow(hwnd)`.
- `hide_terminal(project_id)` → `ShowWindow(hwnd, SW_HIDE)`.

Unlike the old app, we do **not** install a global keyboard hook to trap Alt+F4 or minimize events. If the user closes the hidden console, the child dies and we detect it naturally; the UI shows "stopped" and offers restart. Simpler, less system-level hackery, accidental-close is rare when the console is hidden.

### Automated channel crash handling

- Per-channel task awaits `Child::wait()`.
- If exit occurs within 5s of spawn AND `automation.enabled && autostart_on_boot` → exponential backoff restart (2s, 4s, 8s, 16s, cap). Log to state; surface attempt count in UI.
- If exit occurs after stable runtime (>5s) → single immediate restart attempt.
- If restart itself fails → mark the channel as "crashed", no further auto-retry. User sees the error in UI and can manually restart.
- Manual stop (via UI) sets a `suppress_restart` flag that wins over all the above.

### App shutdown

Tauri shutdown hook invokes `channels::kill_all()`. For each channel:
```
taskkill /T /F /PID <pid>
```
Tree kill is required because `claude` spawns `node` subprocesses. Matches the old app's psutil walk behaviour.

### Phone link

- `bridgeSessionId` is populated async by `session_files` enrichment after registration.
- UI: button disabled with "resolving..." state for up to 10s, then "unavailable" if still absent.
- Click → copy `https://claude.ai/code/<sid>` to clipboard + toast. No QR code in v1.

### Hook registration failure modes

- User declines → persist `hook_registration_declined = true`. Automated channels still work (we own them via child-handle); external detection degrades to detector-only (no rich payloads, no `source`/`reason` semantics, but basic liveness still works).
- `~/.claude/settings.json` missing → create it.
- File exists but is malformed JSON → surface error, do not overwrite, mark declined.
- Existing `SessionStart` or `SessionEnd` hooks present → append to the array, never replace.
- Hook server port changes between launches → re-register idempotently.

### Hook payload validation

- Reject payloads whose origin is not localhost.
- Require `session_id`, `hook_event_name`, `cwd`; drop malformed.
- No additional auth (shared secrets would complicate installer merge; localhost binding matches existing `hook_server.rs` posture).

### Detector edge cases

- Require 2 consecutive ticks of "PID gone" before marking dead → avoids false positive during restart.
- If channel child-handle reports exit but detector says "still alive" → trust the handle.
- Do not mark external instances dead within 30s of registration — claude-code is known to be slow writing session JSONs.

## Migration from `obsidian_claude_remote`

### On first launch after update

- Check for `%APPDATA%\obsidian_claude_remote\config.json`.
- If present and has `vault_path`:
  - Surface one-time banner/modal: "Import existing Obsidian channel?"
  - On accept: create `ProjectConfig { path = vault_path, automation = Some(default) }`, mark as imported, close banner.
  - Offer to deregister old app's Startup `.lnk`.

### Retiring the old app

After the user confirms the new channel is working:

1. Uninstall old app: quit its tray, delete its `.lnk` from `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\`, delete its exe, optionally clear `%APPDATA%\obsidian_claude_remote\`.
2. Dispatch a subagent to do one final pass on the old repo:
   - Prepend `README.md` with a ⚠ "DISCONTINUED" banner pointing at `claude_usage_in_taskbar`.
   - Add `DISCONTINUED.md` with migration steps.
   - Update `CLAUDE.md` with a discontinuation note + date.
   - Commit with `chore: mark discontinued, superseded by claude_usage_in_taskbar`.
   - Push.
3. Archive the GitHub repo via `gh repo archive` (with user confirmation).
4. Delete the local clone.

## Open defaults

Written-down choices so they don't need to be re-asked during implementation. Flag if wrong before the plan is written.

- **Home data source:** unchanged, continues to pull from the existing scraper output.
- **Statistics charts:** one-to-one move of today's existing widgets.
- **Avatar format v1:** emoji string only. Image upload deferred to a later ticket.
- **Default automation session-name-prefix:** `project.name` (which defaults to path basename).
- **External-instance TTL after end:** 60s grace then remove.
- **Sidemenu ordering:** Home, Statistics, Projects, Settings.
- **Project delete UX:** three-dot menu on card and detail view. Confirms first. Kills any running automation before removing the config.

## Testing

- **Unit tests:**
  - `hook_installer` merge logic against fixture `~/.claude/settings.json` files (empty, existing hooks of ours, existing hooks from other apps, malformed).
  - `instances.rs` state transitions (register, re-register, mark_ended idempotency, TTL expiry).
  - `settings.rs` serde round-trip including the new fields, with and without `projects`.
  - `detector.rs` reconcile logic against synthetic process lists.

- **Integration tests** (cargo test with the live Claude binary, following `project_tauri_tests.md`):
  - Spawn an automated channel; verify `SessionStart` arrives and populates registry; kill; verify `SessionEnd` OR detector fallback cleans up.
  - Hook registration round-trip on a temp `CLAUDE_HOME`.

- **Manual:**
  - First-run hook-registration modal on a clean user profile.
  - Import-from-old-app flow.
  - Phone-link click-to-clipboard.
  - Show-terminal for automated channel; verify window appears and is usable.
  - Grid/list toggle on Projects screen.

## Not defined by this spec

- Exact Tauri IPC wire formats (command names listed above are the contract).
- Concrete CSS per view (use existing design tokens + Phosphor icons).
- Test file organization (follow existing project convention).

## Future (deferred)

- Desktop sprite animations per project; wave-when-done notification visual. Data model already carries an avatar field so this plugs in later without migration.
- Avatar image upload UI.
- Multiple automations per project.
- VSCode integrated-terminal attach for external instances.
- QR code for phone link.
- macOS/Linux parity for channel spawning + console show/hide.
