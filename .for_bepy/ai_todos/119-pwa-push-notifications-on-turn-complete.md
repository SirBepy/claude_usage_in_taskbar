---
id: 119
slug: pwa-push-notifications-on-turn-complete
title: PWA push notifications when AI turn completes (PC idle)
status: pending
---

## What

Send a Web Push notification to the phone PWA when an AI turn finishes, but only if the PC app hasn't been used for N minutes (default 3). Idea: Joe walks away from PC mid-session, phone buzzes when Claude replies.

## Pieces

**Rust / daemon (`src-tauri/src/remote_server.rs` + new module):**
- Generate VAPID keypair once, persist in `remote-access.json` (or a sibling file)
- Add `POST /api/push/subscribe` endpoint - accepts a Web Push subscription JSON, stores it
- Add `POST /api/push/unsubscribe` endpoint (for cleanup)
- On every turn `result` event (already emitted by parser): check PC-idle heuristic, if idle > threshold send push via `web-push` crate
- Idle heuristic: track last IPC call timestamp from the Tauri window side; expose via a lightweight `GET /api/push/pc-idle` or just track server-side from the WS heartbeat gap

**Crate to add:** `web-push` (check RustSec + crates.io before pinning version)

**PWA (`src/phone/` or SW file):**
- On first load (or settings): request `Notification` permission
- Call `serviceWorkerRegistration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: VAPID_PUBLIC_KEY })` - public key served from `GET /api/push/vapid-public-key`
- POST subscription to `/api/push/subscribe`
- In the existing SW (`src/sw.js` or equivalent): add `push` event listener - parse payload, call `self.registration.showNotification(...)`

**Config / settings:**
- Idle threshold (default 3 min) - could be a hardcoded const first, surface in settings later
- Toggle in phone settings UI: "Notify me when AI replies (PC idle)" on/off

## Success criteria

- Joe opens PWA on phone, grants notification permission, walks away from PC
- Claude finishes a turn 3+ minutes later
- Phone shows a notification: "Claude replied in [session name]"
- Tapping notification opens the PWA to the right session (notification `data.url` or similar)
- No notification if Joe is actively using the PC app

## Notes

- VAPID subscription expires; need re-subscribe flow (detect 410 Gone from push service and clean up stored sub)
- Push payload should be minimal (session name + truncated last message) - don't leak full content in OS notification center
- PC-idle tracking via WS heartbeat gap is simpler than system idle API; Tauri window `on_window_event` blur/focus can also feed into this
- Context is big enough to do pieces independently; suggest splitting into: (a) VAPID + subscribe endpoint, (b) SW push handler, (c) idle detection + fire logic
