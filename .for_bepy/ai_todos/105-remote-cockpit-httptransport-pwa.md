---
id: 105
slug: remote-cockpit-httptransport-pwa
title: Remote cockpit Phase 3+4 - HttpTransport impl + PWA shell + mobile parity pass
status: parked
---

## Why parked

Depends on ai_todos 103 (authed server) + 104 (pairing/token) and on the Tailscale prereq (BEPY_TODOS Urgent). The transport SEAM it plugs into already exists: `src/shared/transport.ts` (commit 864b10d) defines the `Transport` interface (`call` + `listen`) chosen at boot by `getTransport()`; today only `TauriTransport` exists. Full design: `docs/superpowers/specs/2026-06-15-remote-phone-cockpit-design.md`.

## CRUX discovered 2026-06-15 (read before building HttpTransport)

The transport seam sits where the frontend calls `invoke("<tauri-command>")`, but **Tauri command names != daemon RPC method names**, and some Tauri commands ORCHESTRATE multiple daemon calls + app logic. So `HttpTransport.call` cannot just forward the command name to `/api/rpc`. Examples:
- `run_session` (ipc/chat/run.rs) = daemon `start_session` THEN `send_message` (first prompt) + placeholder/realId handling - NOT 1:1.
- Several `invoke` commands are app-process-only (open_in_editor, window control, some local-FS settings) - no daemon equivalent; these must DEGRADE on the phone.

Chosen approach (Joe, 2026-06-15): **A - a mapping table in HttpTransport** (Tauri-command -> {daemon RPC method(s), arg reshape}) calling the allowlisted `/api/rpc`; unmapped/app-only commands throw "unavailable on remote". Map the core chat commands first (the ones the chat screens call on boot + to drive a turn), degrade the rest. Backend `/api/rpc` + `SAFE_METHODS` allowlist already shipped (ai_todo 103). Widen the allowlist as the map needs more methods (deliberate, per-method).

Build order for this chunk: (1) inventory the exact Tauri commands the core chat screens call on boot + to list/open/send/cancel + answer prompts, and their daemon-RPC equivalents + arg shapes; (2) HttpTransport.call (mapping table -> /api/rpc) + listen (-> WS `/api/sessions/:id/stream?token=`); (3) getTransport() branch on window.__TAURI__; (4) PWA shell + token entry; (5) degrade app-only commands. Unit-test the mapping (mock fetch/WS).

## Scope

1. **`HttpTransport`** implementing the existing `Transport` interface against the Phase 1 server: `call` -> authed REST; `listen` -> authed WebSocket (carry the device token from Phase 2). Then make `getTransport()` branch on `window.__TAURI__` presence (Tauri -> TauriTransport, browser -> HttpTransport). The 33 `invoke` call sites + the `event-store`/`slash` listeners are already routed through the seam, so no UI churn should be needed beyond this.
2. **PWA shell:** a web entry point + service worker + manifest, served over HTTPS (TLS via `tailscale cert` / MagicDNS, required for PWA + to avoid mixed-content with `wss://`). Same SPA, built for the browser, using `HttpTransport`.
3. **Mobile parity / degrade pass (Phase 4):** inventory and handle Tauri-only flows that have no browser equivalent - local file picker / attachment FS paths, any `window.__TAURI__`-only API, permission/AUQ surfaces - either give them an HTTP equivalent or degrade gracefully on the phone. Touch targets / responsive layout sanity for a phone screen.

## Acceptance

- In the desktop webview, behavior is unchanged (still TauriTransport).
- In a phone browser on the tailnet, after pairing, the PWA lists sessions, opens one, streams replies live, sends messages, and cancels - at desktop feature parity (chips included), over the authed HTTPS/wss tailnet channel.
- Tauri-only flows either work via HTTP or degrade with a clear message (no silent breakage).
- `pnpm tsc --noEmit` clean, vitest green, `cargo build` clean.

## Live-test findings 2026-06-15 (Joe ran a real phone against the v0 stub)

Phone connects to the daemon server fine (sees the open sessions list). But everything below traces to ONE fact: the daemon at `GET /` serves a ~60-line throwaway `INDEX_HTML` console hardcoded in `remote_server.rs`, NOT the real SPA. Phase 3 (serve real SPA + HttpTransport) makes 1/2/3/B2 vanish; B needs a separate desktop fix.

1. **Mobile does NOT reuse the real chat UI** — it's the bespoke stub. (fixed by serving real SPA)
2. **Chat content shows empty** — stub renders `event.text || event.delta`, but `ChatEvent` is a tagged union carrying `content[]` blocks with no top-level `text` field, so nothing renders. (fixed by real SPA / `chat-transforms.eventToRenderedMessage`)
3. **Not a PWA** — no PWA shell yet (manifest/service worker). Phase 4.
4. **B2 (phone shows raw `[user_message] [tool_use] [assistant_message]` tags)** — same as #2: stub falls back to `'['+type+']'` because it can't parse the schema.
5. **B (PC never sees the phone's sent user message, only the AI replies)** — `event-store.ts:343` DROPS live `user_message` events (resume-replay dedup); the desktop only ever shows its OWN `pushSynthetic` echo. A phone-sent message has no synthetic on the desktop, so nobody renders it; AI replies aren't dropped, so those show. Requires a small, careful desktop change (deliver live user_messages that have no matching local synthetic), in the fragile parser-dedup zone. Does NOT replace the PC UI - "PC stays as it is" preserved.
6. **A (phone msg only "sends" after leaving the PC chat)** — session was mid-turn/busy, so the phone send hit the existing held-message queue (by design) and flushed on turn-end; the phone gave no "queued" feedback. Add a queued/pending indicator on the remote send path. (confirm exact trigger during build)
