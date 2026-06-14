---
id: 105
slug: remote-cockpit-httptransport-pwa
title: Remote cockpit Phase 3+4 - HttpTransport impl + PWA shell + mobile parity pass
status: parked
---

## Why parked

Depends on ai_todos 103 (authed server) + 104 (pairing/token) and on the Tailscale prereq (BEPY_TODOS Urgent). The transport SEAM it plugs into already exists: `src/shared/transport.ts` (commit 864b10d) defines the `Transport` interface (`call` + `listen`) chosen at boot by `getTransport()`; today only `TauriTransport` exists. Full design: `docs/superpowers/specs/2026-06-15-remote-phone-cockpit-design.md`.

## Scope

1. **`HttpTransport`** implementing the existing `Transport` interface against the Phase 1 server: `call` -> authed REST; `listen` -> authed WebSocket (carry the device token from Phase 2). Then make `getTransport()` branch on `window.__TAURI__` presence (Tauri -> TauriTransport, browser -> HttpTransport). The 33 `invoke` call sites + the `event-store`/`slash` listeners are already routed through the seam, so no UI churn should be needed beyond this.
2. **PWA shell:** a web entry point + service worker + manifest, served over HTTPS (TLS via `tailscale cert` / MagicDNS, required for PWA + to avoid mixed-content with `wss://`). Same SPA, built for the browser, using `HttpTransport`.
3. **Mobile parity / degrade pass (Phase 4):** inventory and handle Tauri-only flows that have no browser equivalent - local file picker / attachment FS paths, any `window.__TAURI__`-only API, permission/AUQ surfaces - either give them an HTTP equivalent or degrade gracefully on the phone. Touch targets / responsive layout sanity for a phone screen.

## Acceptance

- In the desktop webview, behavior is unchanged (still TauriTransport).
- In a phone browser on the tailnet, after pairing, the PWA lists sessions, opens one, streams replies live, sends messages, and cancels - at desktop feature parity (chips included), over the authed HTTPS/wss tailnet channel.
- Tauri-only flows either work via HTTP or degrade with a clear message (no silent breakage).
- `pnpm tsc --noEmit` clean, vitest green, `cargo build` clean.
