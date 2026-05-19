# Verify FOUC in installed app

## Goal

Confirm whether the half-second flash-of-unstyled-content on chats window open is dev-only or also affects the installed app. If it affects the installed app, hunt the missing CSS link.

## Context

Joe reported the flash in `cargo tauri dev`. Investigation (session that landed `c538ff6`) showed:
- `src/index.html` head links 4 stylesheets (tokens, base, themes, mvp-hidden) — blocking, no flash.
- `src/main.ts` JS-imports `widgets.css`, plus view modules import their own CSS (`sessions.css`, `chat.css`, etc.).
- **Production build**: Vite extracts all statically-imported CSS into one chunk and auto-injects a `<link rel="stylesheet">` in the built HTML head. No flash expected.
- **Dev mode**: Vite serves CSS as JS modules that inject `<style>` tags after `main.ts` runs. Flash is expected and fundamental to HMR.

Joe asked for the bump/release first so he can verify in the installed app before committing to a workaround.

## Approach

1. After Joe confirms (or denies) the flash in the installed v0.1.58 build:
   - **Flash gone in install** → no action; close this todo, dev-only behavior is acceptable.
   - **Flash still present in install** → real bug. Inspect `dist/index.html` after `npm run build`; check whether `widgets.css`/view CSS got an auto-emitted `<link>` in the head. If not, add explicit `<link rel="stylesheet">` tags for the critical files (widgets.css, sessions.css, chat.css) to `src/index.html`.
2. Fallback workaround if hunting the missing link is fruitless: add `body { visibility: hidden }` to `src/index.html`'s inline `<style>`, then in `main.ts` after all CSS imports resolve set `document.body.classList.add("app-ready")`, with matching CSS `body.app-ready { visibility: visible }`. Hides everything until JS boots — works in dev + prod, but masks real FOUC bugs forever.

## Acceptance

- Joe confirms whether flash exists in installed build.
- If flash exists in install: chats window opens with no visible style-less frame.
- If flash is dev-only: this todo is deleted, no code change.
