# Bulk apply effort to all running sessions

## Goal

Give Joe a one-action way to change the effort level on every running
Interactive session at once (e.g. "drop everything to low for the next
hour while I'm on battery").

## Context

Deferred from the model/effort picker design at
`docs/superpowers/specs/2026-05-12-model-effort-picker-design.md`. v1
only exposes per-session effort change via the statusbar chip.

After v1 ships, `set_session_effort(session_id, effort)` exists and
mutates one registry entry. Bulk apply = call it for every Interactive
entry.

## Approach

Two viable surfaces:

1. Tray menu item: "Set all sessions to..." → submenu with 5 effort
   levels. Simplest, no new UI screens.
2. Sessions sidebar header: a small "all" dropdown next to the sort
   control. Discoverable but takes sidebar real estate.

Implementation:

- New IPC `set_all_sessions_effort(effort: String)` in `ipc/chat.rs`,
  iterates registry's Interactive entries, calls `set_effort` on each,
  emits one `instances-changed`.
- Skip External/Automated/Remote entries (they don't run through our
  runner).
- Skip currently-busy sessions: change applies at next turn anyway, so
  no special-casing needed.

Rejected: applying effort changes to in-flight turns. The flag is set at
spawn time only; no way to mutate a running process. Document this
limitation in the menu tooltip ("applies to next turn of each session").

## Acceptance

- Triggering bulk apply from the chosen surface updates every Interactive
  session's effort field in one event round-trip.
- Statusbar chips on each open session re-render to the new level.
- External/Automated/Remote sessions are unaffected.
- Each session's next spawned turn uses the new effort flag.
