# AI cleanup pass over the vendored tauri_kit

## Goal

Have an AI do a focused code-health + consistency pass over the shared kit at `vendor/tauri_kit` (the submodule `github.com/SirBepy/sirbepy_tauri_kit`), so it's a strong, consistent base to reuse across claude_usage_in_taskbar, pomodoro-overlay, and future apps. Joe asked for this on 2026-06-11 while we were extracting the new `tauri_kit_audio` module.

## Context

`vendor/tauri_kit` is a cargo workspace of per-feature crates (`tauri_kit_settings`, `tauri_kit_updater`, `tauri_kit_window`, `tauri_kit_meeting`, and now `tauri_kit_audio`) plus matching `frontend/<feature>/` TS modules. It has grown organically. Known inconsistency to look at: the consumer app path-deps `tauri_kit_audio` (proper reuse) but the `meeting` module was historically COPY-PASTED into the app instead of path-dep'd - that divergence is a smell. The kit is a SHARED REMOTE consumed by 2+ apps, so changes must stay backward-compatible (pomodoro pins a submodule sha; a breaking API change forces a coordinated bump). Joe has authorized pushing to the kit remote.

## Approach

Dispatch a read-only audit first (do NOT auto-refactor a shared lib blind): per-crate, look for dead code, duplicated helpers across crates, inconsistent naming/structure between the Rust crates and between the frontend modules, missing/!stale docs, and crates that should share a common util. Produce a findings list ranked by value-vs-risk. THEN apply only the safe, backward-compatible cleanups (no public-API breaks without Joe's ok), one crate at a time, building each (`cargo build -p <crate> --manifest-path vendor/tauri_kit/Cargo.toml`) and running its tests. Reconcile the meeting copy-paste vs path-dep divergence (decide one pattern and apply it). Submodule discipline: commit + push the kit first, then bump the parent pointer. Per-app verification that nothing regressed.

## Acceptance

- A written findings list exists (what was found, what was changed, what was deliberately left).
- Each kit crate still builds + tests green; no public API broken without an explicit Joe decision logged.
- The meeting copy-paste-vs-path-dep inconsistency is resolved (one consistent consumption pattern).
- Kit pushed, parent submodule pointer bumped, claude_usage_in_taskbar still builds (`cargo build --manifest-path src-tauri/Cargo.toml --lib` + `pnpm tsc --noEmit` + `pnpm vitest run`).
