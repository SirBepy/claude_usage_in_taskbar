# Fix list_auto_accept 401 boot race on the remote/phone SPA

**Type:** task

## Goal

Stop the remote (phone) SPA from firing `list_auto_accept` (and possibly other `/api/rpc` calls) before the remote token gate has captured/stored the bearer token, which currently produces repeated `401 Unauthorized` on boot and a hot retry loop in `[auto-accept] hydrate`.

## Context

Found while driving the running daemon's SPA at `http://127.0.0.1:27183/?token=<t>` with Playwright (2026-07-09, during the "client closed" chat investigation). Console showed, repeatedly on boot:

```
[HTTP 401] http://127.0.0.1:27183/api/rpc
[auto-accept] hydrate failed: Error: rpc list_auto_accept failed: 401
```

Ground truth: the SAME `list_auto_accept` method returns **200** via `curl -H "Authorization: Bearer <token>"`, so the method is allowlisted and the token is valid. The 401s are the SPA firing the RPC without (or before) applying `rc_token`. The token is captured by `captureRemoteTokenFromUrl()` at the top of `ensureRemoteToken` in `src/shared/remote-gate.ts`; the auto-accept hydrate (`cy` / `hydrate` in the sessions/auto-accept path) appears to run before that completes, or without awaiting the gate.

Desktop (Tauri transport) is unaffected — this is remote-transport-only. It is NOT the "client closed" bug (that was the daemon panic, fixed in 0.2.12).

## Approach

- Reproduce headlessly per [[project_test_phone_view_headless_daemon]]: run `cc-conductor-daemon.exe`, open `http://127.0.0.1:27183/?token=<token-from-remote-access.json>`, watch console.
- Make the auto-accept hydrate (and any other early `/api/rpc` consumer) await the remote token gate before its first call on the HttpTransport path — e.g. gate the hydrate on the same readiness promise `ensureRemoteToken` resolves, or have `HttpTransport.call` defer until the token is present instead of firing a doomed request.
- Confirm no other boot-time RPCs race the gate (search for callers that fire on module load / first render).

## Acceptance

- Loading the remote SPA with a valid `?token=` shows zero `401` on `/api/rpc` in the console and no `[auto-accept] hydrate failed` retry loop.
- Desktop chat auto-accept behaviour unchanged.
