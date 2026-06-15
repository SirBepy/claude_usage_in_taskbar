---
id: 111
slug: about-page-breaks-pnpm-build
title: About page import breaks `pnpm build` (pre-existing) - proper fix vs the externalize stopgap
status: open
---

## What
`pnpm build` (vite/rollup) FAILS on master: `vendor/tauri_kit/frontend/settings/pages/about.ts`
statically imports `@tauri-apps/plugin-opener`, which is NOT a dependency (package.json has
no `@tauri-apps/*` at all; the app otherwise drives Tauri via `window.__TAURI__`). Introduced
with the About/Updates page (commit 60494a2). Rollup can't resolve the bare specifier ->
build error. The desktop `npm run build` has been broken since then.

## Stopgap already applied (2026-06-15, cockpit work)
`vite.config.ts` now has `build.rollupOptions.external: [/^@tauri-apps\//]` so the build
SUCCEEDS again (required so the daemon can embed `dist/` for the phone SPA). Downside: the
externalized bare import will fail at runtime if/when the About module loads in the webview,
so the About page's "open link" may be broken. This is no worse than the prior state (the app
didn't build at all), but it is not the real fix.

## Proper fix (pick one)
1. If the Rust side registers `tauri-plugin-opener` (check src-tauri/Cargo.toml + capabilities),
   install the JS half: `pnpm add @tauri-apps/plugin-opener@^2`, then REMOVE the `external`
   regex from vite.config.ts. This makes the About "open" actually work + heals the build properly.
2. If the plugin is NOT registered, refactor `vendor/tauri_kit/.../about.ts` to open links via
   the app's existing opener path (the same mechanism used elsewhere, e.g. an `open_*` IPC
   command) instead of `@tauri-apps/plugin-opener`, then drop the `external` regex.

## Acceptance
- `pnpm build` clean WITHOUT the `@tauri-apps` externalize hack.
- The About page's external-link button works in the desktop webview.
- Run a safety check before adding `@tauri-apps/plugin-opener` (official Tauri org crate; verify version pin matches Tauri 2).
