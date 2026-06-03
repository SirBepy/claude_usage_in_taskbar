# Fix pre-existing TS2722 errors in main.ts

## Goal
`pnpm tsc --noEmit -p tsconfig.json` reports two errors that predate the news work and have been latent because `vite build` never typechecks:
```
src/main.ts(157,10): error TS2722: Cannot invoke an object which is possibly 'undefined'.
src/main.ts(163,10): error TS2722: Cannot invoke an object which is possibly 'undefined'.
```
Clearing them gets the frontend to a clean typecheck so real errors aren't buried.

## Context
Both are the cross-window navigation listeners in the `else` branch of `main.ts`:
- line ~157: `void window.__TAURI__?.event?.listen("navigate-to-dashboard", ...)`
- line ~163: `void window.__TAURI__?.event?.listen<string>("navigate-to-project", ...)`
The optional chain stops at `?.event`, but `listen` itself is typed as possibly undefined, so invoking `...listen(...)` trips TS2722. Same root cause was worked around in news.ts by binding `const listenFn = ev.listen.bind(ev)` inside an `if (ev?.listen)` guard.

## Approach
Either add `?.` at the call (`window.__TAURI__?.event?.listen?.(...)`) - simplest - or guard once with `const ev = window.__TAURI__?.event; if (ev?.listen) { ... }` and call through a bound local, matching the news.ts pattern. Don't change behavior; these are boot-time listeners that already no-op when the Tauri API is absent.

## Acceptance
- `pnpm tsc --noEmit -p tsconfig.json` exits 0 (no errors).
- Cross-window navigate-to-dashboard / navigate-to-project still wired (no behavior change).
