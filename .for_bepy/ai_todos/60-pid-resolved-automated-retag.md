# Re-tag channel sessions Automated after the real pid resolves

## Goal

Phase 4 restored the `Automated` correlation on the hook path by pid-matching the SessionStart payload pid against the daemon's channel manager (`hooks_server.rs::on_session_start`). But Claude Code v2.x SessionStart payloads frequently omit `pid` (see memory `project_session_hook_quirks.md`). When the payload pid is absent, `hook_pid` is 0, the channel match short-circuits to `External`, and the session is never re-evaluated even though the background-enrichment block later resolves the real pid via `session_files`. Net effect: channel-spawned claudes still show as External in the common v2.x case, which is the exact symptom Phase 4 set out to fix. The fix is reliable only when the payload happens to carry a pid.

This makes the regression "fixed on paper, intermittently in practice." This todo makes it durable.

## Context

- `src-tauri/src/daemon/hooks_server.rs` — `on_session_start`. The kind decision (`hook_pid` match) runs ~line 160. The background-enrichment `tokio::spawn` block (~line 195) resolves the real pid via `crate::hooks::session_files::resolve_session_meta` and calls `state.registry.set_pid(&sid, meta.pid)`.
- `src-tauri/src/daemon/state.rs` — `DaemonState.channels: Arc<channels::Manager>` (added Phase 4 Task 1).
- `src-tauri/src/sessions/registry.rs` — has `set_pid`, `set_bridge_session_id`, `set_name`. There is **no `set_kind`** yet — this todo must add one.

## Approach

1. Add `pub fn set_kind(&self, session_id: &str, kind: InstanceKind, is_remote: bool) -> bool` to `Registry` (mirror `set_pid`: lock inner, get_mut the instance, update `kind` + `is_remote`, return whether it changed). Only upgrade — guard so it doesn't clobber `Interactive`/already-`Automated`; i.e. only flip when current kind is `External`.
2. In the background-enrichment block of `on_session_start`, after the real pid is resolved (`meta.pid` / `set_pid`), check `state.channels.list().iter().any(|c| c.pid == Some(resolved_pid))`. If matched, call `set_kind(&sid, InstanceKind::Automated, true)` and set `changed = true` so the trailing `instances_changed` notification fires with the corrected kind.
3. Keep the existing immediate match (it still helps when the payload DOES carry a pid — corrects the kind one notification earlier).

## Acceptance

- A channel-spawned session whose SessionStart omits pid is tagged `Automated` once the background enrichment resolves its pid (verify the second `instances_changed` notification carries `kind: "automated"`).
- `set_kind` only upgrades `External` → `Automated`; never downgrades `Interactive`.
- Existing `daemon_channels_e2e` negative test (no matching channel → stays External) still passes.
- Consider extending `daemon_channels_e2e` with a positive case that seeds a channel pid via a test seam (if one can be added without spawning a real `claude --remote-control`).
