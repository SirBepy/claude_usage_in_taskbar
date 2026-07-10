# tauri_kit sync tooling so vendored copies can't silently diverge

**Type:** task

## Goal

A canonical sync story for `vendor/tauri_kit` across Joe's Tauri apps (this app, pomodoro overlay, server supervisor): one source of truth plus a mechanical update path, so per-app copies stop drifting.

## Context

Settings rewrite 2026-07-10: the kit's schema-driven settings framework had already rotted once (rootPage still hardcodes Pomodoro categories; this app hand-rolled everything instead of using it). The rewrite generalized `frontend/settings/pages/system.ts` (sections-as-data, all props but onBack optional) as a kit commit on branch `settings-rewrite-systempage` inside the submodule. tauri_kit here IS a git submodule, so the mechanism half-exists; the missing part is discipline/tooling: the submodule commit was made on a detached HEAD in a worktree, other apps may vendor by copy instead of submodule, and there's no routine "pull latest kit" step. /rate-it verdict during planning: without a sync story this rots again.

## Approach

1. Inventory how each app consumes tauri_kit (submodule vs copied folder).
2. Ensure the canonical repo (wherever origin points) receives the `settings-rewrite-systempage` commit onto main.
3. Add a tiny update script or documented one-liner per app (`git submodule update --remote vendor/tauri_kit` + typecheck) and, for copy-consumers, either convert to submodule or add a copy-sync script.
4. De-Pomodoro the kit rootPage categories (make them injectable like systemPage sections) while in there - rejected during the settings rewrite as out of scope, still worth doing.

## Acceptance

- Each consuming app has a documented, single-command kit update path.
- `pnpm tsc --noEmit` and kit vitest green in this app after a round-trip update.
- The generalized systemPage commit is reachable from the kit repo's main branch.
