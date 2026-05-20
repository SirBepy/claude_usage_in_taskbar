# App should fetch an instance + channel snapshot when it connects to the daemon

## Goal

The app's `cached_instances` (and now `cached_channels`) only populate from `instances_changed` / `channels_changed` notifications that arrive AFTER the app subscribes. There is no snapshot fetch on connect. So when the app launches (or reconnects after a daemon restart), Running Instances shows empty until some new hook/channel event happens to fire - even though the daemon's registry already holds live sessions.

Observed 2026-05-20: a channel was tagged Automated in the daemon's registry, but launching the app afterward showed nothing because the tagging event predated the app's subscription.

## Context

- `src-tauri/src/lib.rs` - startup wiring connects `PersistentClient`, calls `subscribe_global()`, then only reacts to notifications in `handle_daemon_notification`.
- `src-tauri/src/state.rs` - `cached_instances`, `cached_channels`.
- There is currently NO `list_sessions` / `list_instances` RPC method on the daemon (`daemon/methods.rs`) nor a client helper - only the push notifications exist. `list_channels` exists app-side but reads the cache, not the daemon.

## Approach

1. Add a daemon RPC `list_instances` (returns `registry.list()`) and `list_channels` (returns `channels` snapshot json) - or a combined `snapshot` method.
2. Add `daemon_client` helpers for them.
3. On app startup, right after `subscribe_global()` succeeds, fetch the snapshot once and seed `cached_instances` + `cached_channels`, then emit the `instances-changed` / `channels-changed` Tauri events so the UI renders immediately.
4. Re-fetch on reconnect if reconnection logic is added later.

## Acceptance

- Launching the app against a daemon that already has live sessions shows them in Running Instances immediately (no need to wait for the next event).
- Channels already running show in the UI on app launch.
- No duplicate rendering (seed then notifications should reconcile by session_id).
