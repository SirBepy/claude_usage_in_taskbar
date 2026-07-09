# Route-level dynamic imports so windows stop parsing the whole 610KB main bundle

**Type:** task

## Goal

Code-split the main SPA bundle per view so the dashboard window does not parse chat machinery, and detached session windows do not parse dashboard/settings/characters/news code. Boot parse/eval time and per-renderer JS heap drop for every window.

## Context

From the 2026-07-09 performance audit. `src/main.ts` statically imports every view at module top; the built entry is ~610KB JS + ~171KB CSS (after shiki was split out in commit 85707a4e and the overlay got its own ~27KB entry in cc7bedf4). Persistent windows amortize the cost, but detached `session-<id>` windows cold-boot the full bundle on every open, and the dashboard carries all chat code despite possibly never opening a chat. Deferred because of init-order risk: memory "sidebar.ts import cycle" - main.ts injects a re-render callback into the modal/state cluster to break a static cycle; converting view imports to dynamic changes evaluation order and could resurrect that cycle class.

## Approach

- Convert the view imports in `src/main.ts` to `await import()` at route-mount time (the router/branch around main.ts:193 already knows the mode: dashboard vs detached session).
- Keep truly shared plumbing (api/state/ipc, the account-chip chunk) static.
- Watch the sidebar/main.ts injection point: keep the injected re-render wiring in the static part, only lazy-load view render functions.
- Verify with `pnpm exec vite build` that vite emits per-view chunks and the entry drops substantially (target: entry under ~200KB).
- Rejected: separate HTML entries per window class (like overlay.html) - detached windows share too much chat code with the chats window for that to pay off.

## Acceptance

- Entry chunk size drops sharply; detached-window cold boot loads only chat-related chunks (check dist manifest / network panel in dev).
- All windows still boot: dashboard, chats, detached session, overlay; back-button/router/permission-modal wiring intact.
- `pnpm exec tsc --noEmit` clean, full fast vitest suite green, `pnpm exec vite build` succeeds.
