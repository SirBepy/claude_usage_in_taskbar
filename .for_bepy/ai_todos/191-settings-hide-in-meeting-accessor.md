# Duplicate: hideInMeeting extraction implemented 3 times

## Goal
A single `Settings::hide_in_meeting()` accessor instead of three inline `extra.get("hideInMeeting").and_then(|v| v.as_bool()).unwrap_or(false)` copies.

## Context
`src-tauri/src/meeting/mod.rs:193-198` (new `detection_wanted`, 2026-07-09 perf pass), `src-tauri/src/meeting/mod.rs:153-163` (pre-existing inline extraction), and `src-tauri/src/ipc/settings.rs:36` all re-derive the flag by hand. A sibling accessor pattern already exists (`pause_notifications_in_meeting()`).

## Approach
Add `Settings::hide_in_meeting(&self) -> bool` mirroring the existing pause accessor; replace all three call sites.

## Acceptance
Grep shows one definition, three accessor calls, zero inline `hideInMeeting` extractions; `cargo build` passes; meeting gating behavior unchanged (poll idles at 15s when both meeting settings off).
