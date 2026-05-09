# Share channel-status JSON helper between list_channels and emit_changed

## Goal

Drop the duplicated channel -> JSON transformation. Both call sites should
build the same shape from a single helper.

## Context

Two places emit a JSON view of `ChannelSnapshot` and the shapes have drifted
slightly:

- `src-tauri/src/channels/lifecycle.rs:10` — `emit_changed` builds JSON with
  fields `project_id`, `pid`, `status` (string), `hwnd`. Used for the
  `channels-changed` Tauri event.
- `src-tauri/src/ipc/channels.rs:39` — `list_channels` IPC builds the same
  shape but exposes `has_hwnd: bool` instead of `hwnd: <int>`.

Both share the identical `ChannelStatus` -> string match block. The drift
between `hwnd` and `has_hwnd` is also worth resolving (frontend should consume
one or the other; today it likely takes both depending on entry point).

## Approach

1. Add a `pub(crate) fn channel_snapshot_to_json(&ChannelSnapshot) -> Value`
   helper in `src-tauri/src/channels/manager.rs` (lives next to
   `ChannelSnapshot`).
2. Decide one canonical `hwnd` field:
   - Keep `has_hwnd: bool` (frontend doesn't use the raw HWND today)
   - Or keep `hwnd: i64?` (if dashboard ever wants to surface it).
   Pick has_hwnd unless the dashboard already uses the raw hwnd.
3. Replace the inline match + JSON building in `emit_changed` and
   `list_channels` with calls to the helper.
4. Update the frontend type in `src/ipc.generated.ts` if `list_channels`'s
   return shape changes — regen via
   `cargo test --test export_types`.

## Acceptance

- One source of truth for `ChannelSnapshot` -> JSON.
- Frontend consumers (sessions view, projects view) still render channel
  status correctly after the change.
- `cargo test` green.
