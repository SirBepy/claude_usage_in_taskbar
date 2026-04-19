# Tauri Settings Parity — Design Spec

**Date:** 2026-04-20
**Branch:** `tauri-rewrite`
**Scope:** Full settings-tab parity between the Electron app and the Tauri rewrite. Sync is explicitly out of scope. Token-estimation feature is being removed from Tauri entirely.

## Motivation

The Tauri rewrite persists every field the dashboard sends (via the `extra` catch-all on `Settings`), but almost none of those fields actually affect app behavior. The Rust side treats tray icon rendering, tooltip text, notifications, and display-cycling as no-ops. Users can change dropdowns in the Settings tab but nothing changes.

This spec brings the Tauri app to semantic parity with the Electron app for every setting except the Sync subpage.

## Out of scope

- Sync subpage and cross-device push/pull (separate effort).
- Token-estimation feature: being removed entirely from the Tauri frontend (`tooltipEstimateTokens`, `sessionPlan`, `weeklyPlan`, associated UI). The Electron app is untouched.

## Architecture overview

Work splits across four Rust modules (two expanded, three new), plus small frontend trim.

| Module | Status | Responsibility |
|---|---|---|
| `icon.rs` | expand | Full Electron-parity renderer: AA rings, bars, digit overlay with 3 pixel fonts, spin frames. Color decisions driven by `IconSettings`. |
| `tray.rs` | expand | Display-state machine: left-click cycles, 60s reset-to-default, spin animation during manual/hook polls, tooltip rebuild. Single render funnel. |
| `usage_parser.rs` | new | Pure math: `session_pct`, `weekly_pct`, `calc_safe_pct`, `build_tooltip`, `threshold_crossed`. No Tauri deps. Deterministic via injected `now`. |
| `notifications.rs` | new | `fire(kind, ctx)`. Work-finished, question-asked, threshold-crossed. Sound (`rodio`) + voice (Piper or web-speech fallback). Audio queue gate. |
| `piper.rs` | new | Sidecar manager: `status`, `install_voice`, `synthesize`. Voice catalog ported from `src/core/piper.js`. |
| `types.rs` | expand | Typed views: `IconSettings`, `TooltipSettings`, `NotificationsConfig`, `NotificationRule` built via `TryFrom<&Settings>`. |
| `ipc.rs` | expand | New commands for Piper, logs, updater, platform, speak-preview. |
| `electron-api-shim.js` | expand | Bindings for new IPC so dashboard keeps working. |

### Data flow

1. Poll completes → `usage-updated` emitted → `tray::render_tray_now` recomputes icon + tooltip; `scheduler` compares prev/new pcts → fires `ThresholdCrossed` notification if applicable.
2. Hook `POST /refresh` → fires `WorkFinished`. Hook `POST /notify` → fires `QuestionAsked`.
3. Tray left-click (logged in) → `TrayDisplayState::cycle_next()` mutates in-memory state, sets 60s reset deadline → `render_tray_now`.
4. `save_settings` → state mutated → `settings-changed` emitted → tray re-renders with new colors/styles.

Every tray visual update funnels through a single `render_tray_now(app)` function that reads current snapshot, settings, and display state.

## Typed settings views (`types.rs`)

Source of truth remains `Settings.extra: serde_json::Map` (preserves unknown fields on disk). Rust code consumes typed views built on demand. `TryFrom` never panics — malformed fields fall back to defaults.

```rust
pub struct IconSettings {
    pub default_display: DefaultDisplay,    // Icon | Session | Weekly
    pub icon_style: IconStyle,              // Rings | Bars
    pub overlay_style: OverlayStyle,        // Classic | Digital | Bold
    pub color_mode: ColorMode,              // Threshold | Pace
    pub color_thresholds: Vec<ColorStop>,   // sorted asc by `min`
    pub pace_band: f32,
    pub pace_colors: PaceColors,            // under, near_safe, near_over, over
    pub apply_color_to: ColorApplyTo,       // icon/number/dashboard/tooltip flags
}

pub struct TooltipSettings {
    pub layout: TooltipLayout,              // Rows | Compact
    pub time_style: TimeStyle,              // Absolute | Relative
    pub show_safe_pace: bool,
    pub apply_color: bool,
}

pub struct NotificationsConfig {
    pub work_finished: NotificationRule,
    pub question_asked: NotificationRule,
    pub threshold_crossed: NotificationRule,
}

pub struct NotificationRule {
    pub enabled: bool,
    pub mode: NotifMode,            // Sound | Voice
    pub sound_file: String,
    pub voice_name: Option<String>,
    pub template: String,
}
```

## Module public surfaces

```rust
// icon.rs
pub fn render(sess: Option<f32>, weekly: Option<f32>, ctx: &IconCtx) -> Vec<u8>;
pub fn render_spin(frame: u32, weekly: Option<f32>, ctx: &IconCtx) -> Vec<u8>;

pub struct IconCtx<'a> {
    pub settings: &'a IconSettings,
    pub display_mode: DisplayMode,    // Icon | NumberSession | NumberWeekly
    pub session_safe: Option<f32>,
    pub weekly_safe: Option<f32>,
}

// tray.rs
pub fn setup(app: &AppHandle) -> Result<()>;

struct TrayDisplayState {
    temp: Option<DisplayMode>,
    cycle: Vec<DisplayMode>,
    idx: usize,
    reset_deadline: Option<Instant>,
    spin_frame: Option<u32>,
}

// notifications.rs
pub fn fire(app: &AppHandle, kind: NotifKind, ctx: NotifContext);
pub enum NotifKind { WorkFinished, QuestionAsked, ThresholdCrossed }
pub struct NotifContext { pub name: Option<String>, pub percent: Option<u32> }

// piper.rs
pub fn status() -> PiperStatus;
pub async fn install_voice(id: &str) -> Result<()>;
pub async fn synthesize(text: &str, voice_id: &str) -> Result<PathBuf>;

// usage_parser.rs (pure)
pub fn session_pct(snap: &UsageSnapshot) -> f32;
pub fn weekly_pct(snap: &UsageSnapshot) -> f32;
pub fn calc_safe_pct(resets_at: &str, window_ms: i64, now: DateTime<Utc>) -> Option<f32>;
pub fn build_tooltip(snap: Option<&UsageSnapshot>, s: &TooltipSettings, now: DateTime<Utc>) -> String;
pub fn threshold_crossed(prev: Option<f32>, new: Option<f32>, stops: &[ColorStop]) -> bool;
```

## New IPC commands

```
piper_status()                    -> PiperStatus
piper_install_voice(id)           -> Result<()>
piper_speak_preview(text, voice)  -> Result<()>
copy_logs()                       -> Result<()>
check_for_updates()               -> Result<UpdateState>
download_and_install_update()     -> Result<()>
install_update()                  -> Result<()>
get_app_version()                 -> String
get_platform()                    -> String  // "darwin" | "win32" | "linux"
get_update_state()                -> UpdateState
open_external(url: String)        -> Result<()>
```

## Display cycling + spin state machine

### Cycle construction

Matches Electron `buildDisplayCycle` exactly:

- `default_display = icon`    → `[Icon, NumberSession, NumberWeekly]`
- `default_display = session` → `[NumberSession, Icon, NumberWeekly]`
- `default_display = weekly`  → `[NumberWeekly, Icon, NumberSession]`

Cycle invalidated (`cycle.clear()`, `idx = 0`, `temp = None`) when `default_display` changes (`settings-changed` listener).

### Click handler

```
on_left_click:
  if !logged_in: trigger_login(); return
  st = state.display.lock()
  if st.cycle.is_empty(): st.cycle = build_cycle(settings.default_display)
  st.idx = (st.idx + 1) % st.cycle.len()
  st.temp = Some(st.cycle[st.idx])
  st.reset_deadline = Some(now + 60s)
  render_tray_now()
```

Single 1s background reset-ticker (not per-click timer): clears temp state when `reset_deadline` elapsed. Eliminates timer-cancellation races.

### Effective display mode

```rust
fn effective_mode(s: &IconSettings, st: &TrayDisplayState) -> DisplayMode {
    st.temp.unwrap_or_else(|| DisplayMode::from(s.default_display))
}
```

### Spin animation

Spin fires on `PollTrigger::Manual` and `PollTrigger::Hook`, not `Scheduled`. Parity with Electron `refreshWithAnimation`.

```rust
pub enum PollTrigger { Scheduled, Manual, Hook }

pub async fn poll_once(app: &AppHandle, trigger: PollTrigger) -> Result<()> {
    let spinning = matches!(trigger, PollTrigger::Manual | PollTrigger::Hook);
    if spinning { spin_start(app); }
    let result = do_poll(app).await;
    spin_stop(app);
    result
}
```

`spin_start` sets `spin_frame = Some(0)` and starts a 50 ms ticker that increments the frame and triggers `render_tray_now`. `spin_stop` sets `spin_frame = None`. `render_tray_now` uses `icon::render_spin` when `spin_frame.is_some()`, else `icon::render`.

### Single render funnel

```rust
fn render_tray_now(app: &AppHandle) {
    let snap = state.current_usage.lock().clone();
    let icon_s: IconSettings = (&*state.settings.lock()).try_into().unwrap_or_default();
    let tip_s: TooltipSettings = (&*state.settings.lock()).try_into().unwrap_or_default();
    let st = state.display.lock();

    let sess = snap.as_ref().map(usage_parser::session_pct);
    let weekly = snap.as_ref().map(usage_parser::weekly_pct);
    let sess_safe = snap.as_ref().and_then(|s|
        usage_parser::calc_safe_pct(&s.five_hour.resets_at, FIVE_HOUR_MS, Utc::now()));
    let weekly_safe = snap.as_ref().and_then(|s|
        usage_parser::calc_safe_pct(&s.seven_day.resets_at, SEVEN_DAY_MS, Utc::now()));

    let ctx = IconCtx {
        settings: &icon_s,
        display_mode: effective_mode(&icon_s, &st),
        session_safe: sess_safe,
        weekly_safe,
    };

    let bytes = match st.spin_frame {
        Some(f) => icon::render_spin(f, weekly, &ctx),
        None    => icon::render(sess, weekly, &ctx),
    };
    tray.set_icon(Image::from_bytes(&bytes)?);
    tray.set_tooltip(usage_parser::build_tooltip(snap.as_ref(), &tip_s, Utc::now()));
}
```

Every trigger (settings-changed, usage-updated, click, spin tick, reset tick) funnels through this one function.

## Icon rendering

### Rings — ported with anti-aliasing

Port the Electron soft-edge blend formula (`min(1, dist-(innerR-1)) * min(1, outerR+1-dist)`). Current Rust `draw_ring_arc` is hard-edged and must be replaced. Factor to:

```rust
fn paint_band(
    img: &mut RgbaImage,
    r_out: f32, r_in: f32,
    fg: [u8; 3], bg: [u8; 3], bg_alpha: u8,
    include: impl Fn(f32, f32) -> bool,  // (angle, dist) -> in filled region?
);
```

Same fn handles filled-arc rings (`include = angle <= filled_angle`) and spin arc (`include = angle in window`).

### Bars — ported from `drawBars`

Rectangles: session `x∈[3,8] y∈[2,20]`, weekly `x∈[13,18] y∈[2,20]`. Fill-height proportional to pct (`(pct/100)*18`). Track alpha 80, fill alpha 255. Factored helper `draw_filled_column`.

### Digits — 3 pixel fonts

Port `src/core/fonts.js`: classic (5x7), digital (stylized), bold (6x8 rough). Each as `const PixelFont` tables in new `fonts.rs`:

```rust
pub struct PixelFont {
    pub width: u32,
    pub height: u32,
    pub glyphs: &'static [(char, &'static [u16])], // rows as bit-packed u16
}

pub const CLASSIC: PixelFont = ...;
pub const DIGITAL: PixelFont = ...;
pub const BOLD: PixelFont = ...;

pub fn draw_text(img, text, x, y, color, font);
```

Centering (from `makeIcon` lines 273-276):
- `total_w = str.len() * font.width + (str.len() - 1)`
- `x = max(0, (22 - total_w) / 2)`
- `y = max(0, (22 - font.height) / 2)`

Max displayed value `min(round(pct), 99)` — caps at "99".

### Urgency color

```rust
pub fn urgency_rgb(pct: Option<f32>, s: &IconSettings, safe: Option<f32>) -> [u8; 3] {
    let Some(pct) = pct else { return LOADING_BLUE; }
    if s.color_mode == ColorMode::Pace {
        if let Some(safe) = safe {
            let b = s.pace_band;
            return hex(
                if pct < safe - b    { s.pace_colors.under }
                else if pct < safe   { s.pace_colors.near_safe }
                else if pct < safe + b { s.pace_colors.near_over }
                else                 { s.pace_colors.over }
            );
        }
    }
    let mut color = s.color_thresholds.first().map(|t| t.color).unwrap_or(FALLBACK_BLUE);
    for stop in &s.color_thresholds {
        if pct >= stop.min as f32 { color = stop.color; } else { break; }
    }
    hex(color)
}
```

`apply_color_to.icon = false` → caller substitutes `[200, 200, 200]` (matches Electron). Same for `apply_color_to.number`.

### Idle state

`session = None` and `weekly = None` → full rings in `[120, 120, 120]` at 100%. Matches Electron behavior.

## Tooltip and safe-pace

### `calc_safe_pct`

```rust
pub fn calc_safe_pct(resets_at: &str, window_ms: i64, now: DateTime<Utc>) -> Option<f32> {
    let resets = DateTime::parse_from_rfc3339(resets_at).ok()?.with_timezone(&Utc);
    let elapsed = window_ms - (resets - now).num_milliseconds();
    if elapsed <= 0 || elapsed > window_ms { return None; }
    Some((elapsed as f32 / window_ms as f32) * 100.0)
}
```

Deterministic: `now` injected (not `Utc::now()`). `FIVE_HOUR_MS = 5 * 3_600_000`. `SEVEN_DAY_MS = 7 * 24 * 3_600_000`.

### `build_tooltip`

Layouts:

```
Rows:
  Session  45%   resets in 2h 14m
  Weekly   12%   resets Mon 9 AM
  Pace     safe: 38% ✓ under

Compact:
  S 45% · W 12% · pace 38%
```

`time_style = relative` → "resets in Xh Ym". `time_style = absolute` → "resets HH:MM" or "resets Day HH:MM" if not today.

`show_safe_pace = false` suppresses the pace row/segment.

Pure fn, deterministic via injected `now`.

## Notifications

### Trigger sources

| Kind | Trigger | Context |
|---|---|---|
| `WorkFinished` | `hook_server POST /refresh` (after kicking poll) | `name = cwd → project_name` |
| `QuestionAsked` | `hook_server POST /notify` (new endpoint) | `name = cwd → project_name` |
| `ThresholdCrossed` | `scheduler::poll_once` after new snapshot, if `threshold_crossed(prev, new, stops)` | `percent = round(max(new_sess, new_weekly))` |

`threshold_crossed(prev, new, stops)` returns true iff any stop `s` has `prev < s.min <= new`. Pure, tested.

### `fire`

```rust
pub fn fire(app: &AppHandle, kind: NotifKind, ctx: NotifContext) {
    let s = app.state::<AppState>();
    let cfg: NotificationsConfig = (&*s.settings.lock()).try_into().unwrap_or_default();
    let rule = resolve_rule(&cfg, kind);
    if !rule.enabled { return; }
    match rule.mode {
        NotifMode::Sound => audio::play_sound_file(app, &rule.sound_file),
        NotifMode::Voice => {
            let text = render_template(&rule.template, &ctx);
            if text.is_empty() { return; }
            audio::speak(app, &text, rule.voice_name.as_deref());
        }
    }
}

fn render_template(tpl: &str, ctx: &NotifContext) -> String {
    let name = sanitize_for_speech(ctx.name.as_deref().unwrap_or(""));
    let pct = ctx.percent.map(|p| format!("{p}%")).unwrap_or_default();
    sanitize_for_speech(&tpl.replace("{name}", &name).replace("{percent}", &pct))
}

fn sanitize_for_speech(s: &str) -> String {
    s.chars()
        .map(|c| if matches!(c, '_' | '-') { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
```

### Audio playback

`rodio` crate. One shared `OutputStream` in `AppState`. Queue gate with `AUDIO_GAP_MS = 200` between plays to prevent overlap (mirrors Electron). Assets copied to `tauri/assets/sounds/*.mp3` from `src/assets/sounds/`.

### Voice — Piper + web-speech fallback

```
speak(text, voice):
    if let Some(v) = voice:
        if piper::status().installed && piper::has_voice(v):
            wav = piper::synthesize(text, v).await?
            audio::queue_wav(wav)
            return
    // fallback to renderer-side speechSynthesis
    app.emit("speak-fallback", { text, voice_name: voice })
```

Dashboard renderer listens for `speak-fallback` and calls `speechSynthesis.speak(new SpeechSynthesisUtterance(text))`. No headless TTS needed on Rust side.

## Piper sidecar

### Layout

- Binary: `piper.exe` (win), `piper` (mac/linux) declared in `tauri.conf.json` `bundle.externalBin`.
- Voices: `<data_dir>/piper/voices/<id>/{model.onnx, model.onnx.json}`. Matches Electron layout.

### `piper.rs`

```rust
pub struct PiperStatus {
    pub installed: bool,          // binary bundled
    pub voices: Vec<VoiceEntry>,
}

pub struct VoiceEntry {
    pub id: String,
    pub label: String,
    pub installed: bool,
}

pub fn status() -> PiperStatus;
pub async fn install_voice(id: &str) -> Result<()>;
pub async fn synthesize(text: &str, voice_id: &str) -> Result<PathBuf>;
```

Voice catalog (IDs + download URLs) ported verbatim from `src/core/piper.js`. `install_voice` downloads `.onnx` + `.onnx.json` to voices dir. `synthesize` spawns sidecar `piper --model <path> --output_file <tmp.wav>`, pipes `text` to stdin, waits for exit, returns wav path.

## Miscellaneous wiring

- **`launch_at_login`**: plugin already plumbed. Add `settings-changed` listener that calls `autolaunch.enable()`/`disable()` when `autostart` changes (currently only applied at startup).
- **`auto_update`**: add to `Settings`. Startup: if enabled, `tauri_plugin_updater::check()` + 6h interval. Manual `check_for_updates` IPC always available. Mac hides the toggle (existing behavior).
- **`copy_logs`**: read log file via `tauri_plugin_log` path, write contents to clipboard via `tauri_plugin_clipboard_manager`.
- **`get_platform`**: `std::env::consts::OS` normalized to Electron values (`"darwin"`, `"win32"`, `"linux"`).
- **Frontend shim (`electron-api-shim.js`)**: bindings for every new IPC command above. Existing `window.electronAPI.xxx` callers keep working unchanged.
- **Token-estimate strip**: remove `tooltipEstimateTokens`, `sessionPlan`, `weeklyPlan`, `tokenEstimateFields` DOM + settings.js references. `saveSettings` gather fn drops the fields. Electron codebase untouched.
- **`apply_color_to.dashboard`**: enforced in the dashboard renderer (frontend) — the dashboard reads the flag and swaps between urgency-colored and neutral CSS classes. Rust side does not consume this flag. Audit the Tauri `dashboard.js` for parity with the Electron version and wire the flag if missing.

## Testing strategy

**Pure unit tests** (no Tauri runtime, fast):

- `usage_parser`: `session_pct`, `weekly_pct`, `calc_safe_pct` with fixed `now`, `build_tooltip` snapshot tests for all layout/time combos, `threshold_crossed` crossing table.
- `icon`: `urgency_rgb` threshold + pace + None + `apply_color_to.icon=false`, sample-pixel checks for rings/bars/digits.
- `fonts`: glyph bit patterns render expected pixels.
- `notifications::render_template` + `sanitize_for_speech`.
- `TrayDisplayState`: build_cycle, cycle_next wrap, effective_mode fallback.
- `piper::scan_voices_dir` on empty + populated temp dirs.

**Integration tests** (cargo + vitest, per existing `tauri/tests/` split):

- `save_settings` with new color scheme → `usage-updated` → icon bytes differ from previous render.
- Notification fire path end-to-end with fake audio player.
- Settings JSON round-trip preserves every field (regression guard for `extra` flatten).

**Manual QA checklist** (once implemented):

- Click tray icon 3× cycles display; 60s idle returns to default.
- Change `default_display` in settings; cycle order updates.
- Switch `icon_style` rings ↔ bars; visual change.
- Change `overlay_style`; digit font changes.
- Toggle `color_mode` threshold ↔ pace; colors react to pace vs thresholds.
- Adjust `color_thresholds`; icon recolors live.
- Hook `POST /refresh` plays `workFinished` sound.
- Threshold crossing during poll plays `thresholdCrossed` sound.
- Install a Piper voice; preview plays Piper-quality audio.
- Toggle each `color_apply_to` flag; icon/number/tooltip/dashboard color respects flag independently.

## Implementation order

Suggested for the follow-on plan:

1. `types.rs` typed views + `TryFrom` (no behavior change yet).
2. `usage_parser.rs` + tests (pure, unblocks tooltip + safe-pace).
3. `icon.rs` port: AA rings + urgency_rgb + apply_color_to (visual parity at rest).
4. `fonts.rs` + digit overlay in `icon.rs`.
5. Bars mode in `icon.rs`.
6. `tray.rs` display-state machine + click cycle + reset ticker.
7. Spin animation + `PollTrigger` threading.
8. `tray.rs` tooltip rebuild using `build_tooltip`.
9. `notifications.rs` + `rodio` audio queue.
10. `piper.rs` sidecar + bundle config.
11. Web-speech fallback wiring in dashboard.
12. Misc wiring: `launch_at_login` listener, `auto_update`, `copy_logs`, platform, external open.
13. Frontend shim additions.
14. Token-estimate strip from Tauri frontend.
15. Integration tests + manual QA.

## Success criteria

- Every non-sync setting in the Settings tab affects app behavior.
- Left-click on tray cycles icon → session% → weekly% and returns to default after 60 s.
- Icon, tooltip, and notifications all respect color thresholds, pace mode, and `apply_color_to` flags.
- Manual refresh + hook refresh show spin animation.
- Work-finished, question-asked, and threshold-crossed notifications fire with configured sound or voice.
- Piper voices install and synthesize. Web-speech fallback works when Piper unavailable.
- Token-estimate UI is gone from Tauri; Electron app unchanged.
- All pure modules have unit tests. Settings round-trip preserves unknown fields (existing test still passes).
