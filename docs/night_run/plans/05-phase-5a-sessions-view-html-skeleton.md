# Phase 5a - view-sessions HTML + sidemenu + CSS skeleton

## Context

Implements Task 5.1 of `docs/superpowers/plans/2026-05-07-claude-chat-hub.md`. Frontend-only work; no Rust changes. Read "Task 5.1: Add view-sessions HTML scaffold + sidemenu entry" in the parent plan.

The repo's frontend is a single-page SPA. Look at how existing views (e.g. `view-projects`) are wired in `src/index.html` and `src/dashboard.js` before adding the new ones.

## Goal

- Add `Sessions` and `History` entries to the sidemenu in `src/index.html`. Use Phosphor icons (`ph-chats-circle`, `ph-clock-counter-clockwise`).
- Add `<section id="view-sessions" class="view" hidden>` with the layout from the parent plan (sidebar with filter + list, main session pane with empty state).
- Add `<section id="view-history" class="view" hidden>` minimal scaffold.
- Append CSS to `src/dashboard.css` for `.sessions-layout`, `.sessions-sidebar`, `#sessions-list`, `.session-status-dot` (running/input/done states), `.session-pane`, `.session-empty`, `.session-header`, `.session-messages`, `.session-composer`. Match existing CSS variable conventions (look at the file).
- Register both views in `src/dashboard.js` router.
- Set `view-sessions` as the default landing view.

## Implementation

Follow the parent plan's Task 5.1 steps verbatim. Key code blocks:
- Sidemenu entries (Step 2)
- view-sessions container HTML (Step 3)
- view-history container HTML (Step 3)
- Base CSS (Step 4)
- Router registration (Step 5)
- Default landing change (Step 6)

For the router in `dashboard.js`, find the existing view-switching logic. If it's a map of view IDs to activator functions, add entries pointing to dynamic imports of `./modules/sessions-view.js` and `./modules/history-view.js`. Those module files don't exist yet (they're created in Phases 5c and 8b). For now, register lazy-load handlers that gracefully no-op if the module file is missing - or just register the IDs and let the actual imports fail loudly when those files are added. Either is fine; the latter is simpler.

Most tractable approach: do not import the JS modules in this phase. Just add the views, sidemenu entries, CSS, and update the router to recognize the new view IDs without yet wiring activator logic. Phase 5c (sessions-view.js) and Phase 8b (history-view.js) will add the activators.

For the default landing change: locate where `view-dashboard` (or whatever the current default is) becomes visible on app startup, change it to `view-sessions`.

## Verification

The dev server requires `cargo tauri dev`. Night-run is unsupervised - DO NOT spawn `cargo tauri dev`. Instead, manually inspect the HTML/CSS/JS changes for correctness:
- Run `cargo build -p claude-usage-tauri` to confirm no Rust regressions.
- Run `cargo test -p claude-usage-tauri --lib` to confirm 174 tests still pass (no Rust-side change).
- Read the modified files and visually verify:
  - The sidemenu has two new `<li>` entries with the Phosphor icons.
  - The two new view sections exist with correct ids and `hidden` attribute.
  - `dashboard.css` has the new selectors.
  - `dashboard.js` switches default view to `view-sessions`.

Joe will manually exercise the UI in the morning when he wakes.

## Gotchas

- The repo loads Phosphor via CDN per global rule. Confirm `<script src="https://unpkg.com/@phosphor-icons/web"></script>` is in `index.html`. If not, add it - but ONLY if not already present.
- Burger button + `data-burger="true"` must match the existing convention. Read other views' headers first.
- The `hidden` attribute is the de facto view-toggle pattern in this repo. Use it.
- CSS variable names like `--border`, `--accent`, `--muted` may or may not exist in the current `dashboard.css`. If they don't, fall back to literal hex colors as the parent plan's snippets do.

## Don't

- Don't commit.
- Don't run `cargo tauri dev`.
- Don't add JS modules; leave activator wiring for later phases.
- Don't restructure unrelated views.

## Acceptance

- `src/index.html` has both new view sections + sidemenu entries.
- `src/dashboard.css` has the new selectors.
- `src/dashboard.js` recognizes `view-sessions` and `view-history` as valid view IDs and switches to `view-sessions` by default on startup.
- 174 lib tests still pass.
- No console errors when navigating to the new views (verified at the implementation level - empty divs render).
