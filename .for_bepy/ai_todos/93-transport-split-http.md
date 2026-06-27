# transport.ts should split HttpTransport into its own file

## Goal
Move the `HttpTransport` class out of `transport.ts` into a new `http-transport.ts` so that each file has a single transport concern and stays under 250 lines.

## Context
`src/shared/transport.ts` is 418 lines and holds two independent transport implementations:
- `TauriTransport` (lines 24–44, ~20 lines) + the `Transport` interface + `getTransport`/`isTauri`/`isRemote` utilities
- `HttpTransport` (lines 109–395, ~286 lines) — the phone/PWA transport, with its own auth failure handling, `nonStreamable` set, WebSocket session management, and mapping table

The two classes share the `Transport` interface but are otherwise independent.

## Approach
Create `src/shared/http-transport.ts`. Move `HttpTransport`, `RemoteUnavailableError`, `REMOTE_TOKEN_KEY`, `REMOTE_TOKEN_EXPIRED_KEY`, the `handleAuthFailure` helper, and `remoteToken()` into it. `transport.ts` keeps the interface, `TauriTransport`, and `getTransport`/`isTauri`/`isRemote`. Import `HttpTransport` from `./http-transport` in `transport.ts` (for `getTransport`).

## Acceptance
- `transport.ts` < 100 lines, `http-transport.ts` < 350 lines
- `pnpm tsc --noEmit` passes (no new errors)
- Remote phone transport still works (no runtime regressions)
