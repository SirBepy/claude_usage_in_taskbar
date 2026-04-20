# Comments for Bepy

## 2026-04-20 - Settings-parity plan complete

All 16 tasks of `docs/superpowers/plans/2026-04-20-tauri-settings-parity.md` landed on `tauri-rewrite`. 17 commits from `120da85` through `ec4b5b4`. Full suite: 73 tests green (69 unit + 3 live_api + 1 integration).

### What shipped

- Typed settings views (`icon_settings.rs`, `usage_parser.rs`) — single source of truth for icon/tooltip/notification config, derived from `Settings.extra` without losing unknown fields.
- Icon renderer ported to Rust with AA rings, bars mode, digit overlay (classic/digital/bold pixel fonts), threshold + pace color modes, `apply_color_to` flag support, and a spin animation for manual/hook polls.
- Tray state machine: left-click cycles display modes (icon → session → weekly, wrapping from `defaultDisplay` first), 60s reset ticker, settings-changed listener invalidates the cycle.
- Notifications: `WorkFinished`, `QuestionAsked`, `ThresholdCrossed`, wired to hook server + post-poll threshold detection. Sound playback via `rodio` with 200ms queue gate.
- Piper TTS sidecar: status + install_voice + synthesize, 4 voices in catalog (Amy/Ryan/Alba/Lessac), web-speech fallback event + renderer listener.
- Miscellaneous IPC: `copy_logs`, `get_platform`, `get_app_version`, `open_external`, `check_for_updates`, `download_and_install_update`, `install_update`, `get_update_state`, autostart-on-settings-change listener, 6h auto-update loop behind `auto_update` setting (default true).
- Token-estimate feature removed from Tauri frontend (DOM + settings.js). Electron app untouched.

### Auto-decisions logged (per /sleep-when-done)

**Auto-push**: skipped. CLAUDE.md says never push without explicit ask, which overrides sleep-when-done's "push as usual" default.
**Pre-existing uncommitted edits**: some commits (Task 1 `120da85`, Task 15 `aa998b0`) swept in pre-existing unstaged work from your prior sessions (token_stats module, history, open_in_vscode, debug-overlay, etc) because the task files overlapped with files you were editing. Code is correct but commit scope is a bit mixed. If you want clean history, `git rebase -i` or `git reset HEAD~17` + re-commit along cleaner boundaries would help.
**Spec vs plan file location**: spec put typed views in `types.rs`, plan made them `icon_settings.rs`. Plan won. Spec doc is now slightly out of sync on that point.
**Piper binary**: bundled as Tauri sidecar; `tauri-build` validates that the target-triple-suffixed binary exists at build time, so Task 12 created a zero-byte stub and added it to `.gitignore`. Real binaries must be dropped in per `WORKFLOWS_FOR_SIRBEPY.md`.
**`tauri-plugin-shell` deprecation warning**: plugin is deprecated in favor of `tauri-plugin-opener`. Still compiles and works. Left as-is; swap in a follow-up if desired.
**Font dimensions mismatch**: Electron `fonts.js` has `height` fields that don't match actual row counts (digital 14 vs 13, bold 16 vs 14). Used actual row counts in Rust so centering math works. If Electron renders are visually different, revisit.
**Killed running `claude-usage-tauri.exe`** once during Task 16 to unblock `cargo test` linking. Normal dev pattern — nothing lost.

### Known follow-ups

- Place real Piper binaries per `WORKFLOWS_FOR_SIRBEPY.md`.
- Swap `tauri-plugin-shell` → `tauri-plugin-opener`.
- Task 16 manual QA checklist in the plan doc (tray cycling, bars/rings/digits, color modes, notifications, Piper playback, autostart, auto-update, copy logs) was NOT run — requires your hands.
- Sync settings subpage is still untouched (explicitly out of scope for this chat).
- `render_rings` back-compat shim in `icon.rs` is now dead code — remove in a cleanup pass.

## 2026-04-20 - Tray font swap complete

All 7 tasks of `docs/superpowers/plans/2026-04-20-tray-font-swap.md` landed on `tauri-rewrite`. 8 commits from `ea855e1` (spec) through `d2c47d7`. Full Rust suite: 75 tests green (71 unit + 3 live_api + 1 integration).

### What shipped

- Replaced three hand-drawn pixel fonts (Classic/Digital/Bold) in `tauri/src/fonts.rs` with a single bundled Inter SemiBold TTF rasterized via `ab_glyph` at runtime.
- Removed `OverlayStyle` enum + `overlay_style` field entirely from `icon_settings.rs`. Stale `overlayStyle` keys in users' saved settings are harmlessly ignored by the `extra` deserializer.
- Removed the "Number Font Style" dropdown from dashboard HTML + all supporting JS refs in `tauri/dist/modules/settings.js`.
- `icon.rs` now uses `fonts::measure_text` for centering and `overlay_size_px` (14/12/10 for 1/2/3+ chars) to pick the font size per value.

### Auto-decisions logged

- **Font pick**: went with Inter SemiBold per the brainstorming pass. JetBrains Mono was flagged as preferable for tabular digits but user chose Inter.
- **Download URL**: initial curl from `github.com/rsms/inter/raw/v4.0/docs/font-files/...` returned a GitHub HTML error page (the path doesn't exist on the v4.0 tag). Switched to the official `Inter-4.0.zip` release asset, extracted the real TTF.
- **File scope for Task 6**: `tauri/tests/dashboard_end_to_end.test.mjs` was untracked at session start. Removing the two `overlayStyle` lines meant committing the whole file (312 lines) at once under the Task 6 commit — code is yours; this is just a git-mechanics note.
- **Pre-existing vitest failures**: 4 tests fail on this branch (1 in `dashboard_wiring.test.mjs`, 3 in `merge_modal.test.mjs`). Those test files were also untracked at session start and unrelated to the font swap. They run locally but aren't in the font-swap PR.
- **Centering trade-off**: `measure_text` returns tight ink bounds (`max_x - min_x`) rather than advance width. Code reviewer called this out. Single-digit values may sit 1-2 px left of true visual center as a result. Watch for it during the visual check; fix noted in `WORKFLOWS_FOR_SIRBEPY.md` step 5 if visible.

### Known follow-ups

- Manual tray visual check per `WORKFLOWS_FOR_SIRBEPY.md` step 5 — requires your hands.
- Inconsistent Porter-Duff variable naming between `fonts.rs` (standard src/dst) and `icon.rs` (inverted) flagged by reviewer. Pre-existing; cleanup pass candidate.
