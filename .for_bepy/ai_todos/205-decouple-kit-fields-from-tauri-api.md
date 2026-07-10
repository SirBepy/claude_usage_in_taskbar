# Decouple tauri_kit fields.ts from @tauri-apps/api so app pages can compose kit fields

**Type:** task

## Goal

Make `vendor/tauri_kit/frontend/settings/fields.ts` importable from this app's frontend, so settings pages (System, future ones) can compose kit `Field[]` renderers instead of hand-building rows.

## Context

Settings rewrite 2026-07-10, task T5: the plan wanted the app's System page composed from the kit's generalized `systemPage`, but `fields.ts` has an unconditional top-level `import { invoke } from "@tauri-apps/api/core"` (used by the FileField picker), and this app deliberately bundles NO `@tauri-apps/*` packages (uses `window.__TAURI__` + `shared/ipc.ts` shim; see comment in `src/views/settings/subviews/system/system.ts` and `overlay-drag.ts`). Even lazy `await import()` fails Vite import-analysis. So the System page ships with app-local row builders (`src/views/settings/ui.ts`) and the kit generalization is only exercised by kit tests + other apps.

## Approach

- In the kit: inject the invoke dependency - e.g. FileField gains a `pick: () => Promise<string|null>` callback in its field def, or the renderer takes an `invoke`-like function in deps; default it from `@tauri-apps/api` only via a lazy factory the consumer opts into.
- Kit tests updated; then (optional follow-up) migrate this app's System page simple fields (Startup toggle) onto kit fieldRow to prove the composition path.
- This is a submodule change: coordinate with ai_todo 200 (kit sync tooling).

## Acceptance

- An app file importing the kit field renderer passes `pnpm tsc --noEmit` AND `pnpm vite build` in this repo with zero @tauri-apps packages installed.
- Kit vitest suite green.
