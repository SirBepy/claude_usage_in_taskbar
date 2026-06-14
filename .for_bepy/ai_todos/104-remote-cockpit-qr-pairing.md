---
id: 104
slug: remote-cockpit-qr-pairing
title: Remote cockpit Phase 2 - QR pairing, device registry, revoke, kill switch
status: parked
---

## Why parked

Depends on ai_todo 103 (the authed server) existing, and is part of the security boundary, so it needs Joe's review. Full design: `docs/superpowers/specs/2026-06-15-remote-phone-cockpit-design.md`.

## Scope

- **QR pairing:** PC shows a QR encoding `{ MagicDNS host + a single-use, short-TTL (~2 min) pairing code }`. The phone scans it, then exchanges the one-time code (over the already-Tailscale-encrypted channel) for a long-lived **per-device bearer token**. The token, not the QR, is the lasting credential.
- **Device registry:** store paired devices (name + hashed token + created-at) in daemon-owned state; tokens stored hashed, never plaintext.
- **Revoke + kill switch UI:** a settings surface listing paired devices with per-device revoke, plus a global kill switch that instantly disables the remote server (Phase 1 server checks it on every request / stops accepting).

## Acceptance

- Scanning the QR on a fresh phone provisions a working device token; a used or expired code is rejected.
- Revoking a device immediately 401s its token; the kill switch immediately stops remote access.
- Tokens are stored hashed; pairing-code single-use + TTL enforced (unit-tested).
- Reviewed by Joe before real use.
