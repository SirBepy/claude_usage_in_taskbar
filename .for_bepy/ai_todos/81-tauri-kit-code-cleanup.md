# AI cleanup pass over the vendored tauri_kit

## Goal

Have an AI do a focused code-health + consistency pass over the shared kit at `vendor/tauri_kit` (the submodule `github.com/SirBepy/sirbepy_tauri_kit`), so it's a strong, consistent base to reuse across claude_usage_in_taskbar, pomodoro-overlay, and future apps. Joe asked for this on 2026-06-11 while we were extracting the new `tauri_kit_audio` module.

## Context

`vendor/tauri_kit` is a cargo workspace of per-feature crates (`tauri_kit_settings`, `tauri_kit_updater`, `tauri_kit_window`, `tauri_kit_meeting`, and now `tauri_kit_audio`) plus matching `frontend/<feature>/` TS modules. It has grown organically. Known inconsistency to look at: the consumer app path-deps `tauri_kit_audio` (proper reuse) but the `meeting` module was historically COPY-PASTED into the app instead of path-dep'd - that divergence is a smell. The kit is a SHARED REMOTE consumed by 2+ apps, so changes must stay backward-compatible (pomodoro pins a submodule sha; a breaking API change forces a coordinated bump). Joe has authorized pushing to the kit remote.

## Approach

Dispatch a read-only audit first (do NOT auto-refactor a shared lib blind): per-crate, look for dead code, duplicated helpers across crates, inconsistent naming/structure between the Rust crates and between the frontend modules, missing/!stale docs, and crates that should share a common util. Produce a findings list ranked by value-vs-risk. THEN apply only the safe, backward-compatible cleanups (no public-API breaks without Joe's ok), one crate at a time, building each (`cargo build -p <crate> --manifest-path vendor/tauri_kit/Cargo.toml`) and running its tests. Reconcile the meeting copy-paste vs path-dep divergence (decide one pattern and apply it). Submodule discipline: commit + push the kit first, then bump the parent pointer. Per-app verification that nothing regressed.

## Audit done, cleanup PARKED (autopilot 2026-06-17)

A read-only audit ran (the cheap, safe half). The write half is PARKED: it needs the
pomodoro-overlay repo open + Joe, because the kit is a SHARED remote and "unused" was
only assessed from claude_usage's side. Do NOT delete kit crates based on this app alone.

**Why parked (the trap):** an unsupervised cleanup would have deleted `tauri_kit_settings`,
`tauri_kit_updater`, `tauri_kit_window`, `tauri_kit_meeting`, and ~14 frontend settings
modules as "unused" - but they're unused BY claude_usage, which only path-deps
`tauri_kit_audio`. pomodoro-overlay pins this submodule and almost certainly consumes
exactly those crates: the frontend `settings/pages/root.ts` literally hardcodes Pomodoro
section categories, proving pomodoro uses the settings UI. Deleting them would break
pomodoro and force a coordinated bump. That's a hard-to-reverse shared-lib blast radius =
autopilot Hard Stop. NEXT PASS must first grep the pomodoro-overlay repo for
`tauri_kit_settings|tauri_kit_updater|tauri_kit_window|tauri_kit_meeting` + the frontend
imports before deleting anything.

**Genuinely safe (additive, but still a shared-kit push + submodule bump, so batch with the rest):**
- README.md is stale (lists only settings+updater; omits audio/meeting/window). CHANGELOG.md
  still says "Initial repo skeleton". Both want a rewrite to the real inventory.
- Missing crate-level `//!` docs on `tauri_kit_updater` (2-line) and a top-level summary on
  `tauri_kit_meeting` lib.rs (browser-scoping design intent).

**The meeting divergence (BREAKING - needs a Joe decision, do not auto-pick):**
- claude_usage COPY-PASTED meeting into `src-tauri/src/meeting/{mod,signal,windows_source}.rs`
  instead of path-dep'ing `tauri_kit_meeting`. The two have DRIFTED: the kit's
  `SignalSource::camera_in_use(&self, browsers: &[String])` is browser-SCOPED; the app's
  `camera_in_use(&self)` is UNSCOPED (scans the whole consent registry). ~75% of
  windows_source.rs and ~50% of signal.rs are still identical. A path-dep swap is NOT clean:
  it needs the trait signatures reconciled in BOTH repos (pick scoped vs unscoped) plus the
  app would lose live `set_apps()/set_browsers()`. Options: (A) document the fork, leave both
  (cheapest, README-only); (B) simplify the kit to the app's unscoped trait + path-dep both
  consumers (real cross-repo work); (C) leave as-is so pomodoro keeps browser-scoping.
  Recommend A unless Joe wants true convergence.

**To resume:** open pomodoro-overlay, confirm what it actually imports, then apply only the
deletions that are unused across ALL consumers, do the doc rewrites, decide the meeting fork
with Joe, push the kit, bump the parent pointer, and verify both apps build.

## Acceptance

- A written findings list exists (what was found, what was changed, what was deliberately left).
- Each kit crate still builds + tests green; no public API broken without an explicit Joe decision logged.
- The meeting copy-paste-vs-path-dep inconsistency is resolved (one consistent consumption pattern).
- Kit pushed, parent submodule pointer bumped, claude_usage_in_taskbar still builds (`cargo build --manifest-path src-tauri/Cargo.toml --lib` + `pnpm tsc --noEmit` + `pnpm vitest run`).
