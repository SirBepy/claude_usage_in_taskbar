# Dev webview randomly goes white/unstyled at runtime

## Goal

Find and fix the cause of the chats window (and likely the whole app) intermittently dropping all CSS at runtime, leaving an unstyled white page with plain-text nav that doesn't recover on Ctrl+R / Ctrl+Shift+R.

## Context

Happened in `cargo tauri dev` on 2026-06-30. The "Claude Chats" window (session-chats window) suddenly went white mid-session with no user action. Screenshot: nav rendered as raw unstyled text + icons ("Claude Conductor", Home/Chats/Statistics/Skills/Projects/Characters/News/Settings) on a white background, main content blank. Key signal: the **nav itself was unstyled**, not just a blank content pane, so the whole document lost its stylesheet rather than a single view throwing.

Diagnosis attempted at the time:
- Vite was alive and serving (`::1:1420`, the app's own vite at `node_modules/.pnpm/vite@5.4.21...`). Only ONE vite running, so it was NOT a live port-1420 collision in this instance.
- No JS-diff cause: only uncommitted changes were the handoff feature in `chat-*.ts` / `active-session.ts` / new `handoff.ts`, none touching CSS or the shell.
- Ctrl+R and Ctrl+Shift+R did NOT recover it (this is the important anomaly — a transient HMR repaint should recover on reload). Full kill + restart was the only path.

Working hypotheses, in rough priority:
1. HMR full-page reload served the HTML before CSS/JS, but something then wedged so reload didn't re-fetch (service-worker / cache? CSP? webview state). The Ctrl+R-doesn't-fix part argues against a pure repaint race.
2. Port-1420 collision with another Tauri dev app at some earlier moment poisoned a cache, even though only one vite was live at investigation time. See related id and memory "Vite port 1420 collision".
3. A thrown error during a live chat turn ejected lit's managed root. See memory "Router root is lit-managed" (root.innerHTML= ejects lit markers) and "lit-html can't render <select> in a .map() row". If the shell re-rendered through a broken path, CSS-bearing elements could be dropped.
4. CSP mismatch blocking the stylesheet after a reload — see memory "CSP lives in two places" (src/index.html meta + tauri.conf.json must agree).

## Approach

- Reproduce: run `cargo tauri dev`, open the chats window, and try to trigger via (a) saving a file to force HMR full reload, (b) launching a second Tauri dev app to contend port 1420, (c) running a live chat turn that exercises the new handoff/CTA render path.
- When white, before killing: open the webview devtools console and capture the actual error + Network tab to see whether the CSS request 404'd, was CSP-blocked, or was never re-issued. This single observation likely picks the branch — get it before theorizing further.
- Check whether a service worker / cache is involved (the phone PWA uses `claude-companion-v1`; confirm the desktop dev webview isn't serving a stale cached shell).
- If it's the 1420 race: this is the long-pending port-move. Move this app's vite off 1420 via the server_supervisor allocator (see memory "Vite port 1420 collision" / "Defer to resource allocator").

## Acceptance

- Root cause identified with a concrete observation (console error or Network entry), not a guess.
- Either the white screen no longer reproduces under the trigger found, OR Ctrl+R reliably recovers it if a transient race is unavoidable.
- Must NOT regress: the lazy dashboard-window build (white-ghost fix), chat hosting via daemon, CSP in both locations staying in sync.

## Related

- ai_todo (port move pending) — memory "Vite port 1420 collision".
- Memories: "Router root is lit-managed", "CSP lives in two places", "White ghost window fix".
