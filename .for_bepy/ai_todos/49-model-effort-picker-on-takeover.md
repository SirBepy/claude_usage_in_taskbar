# Model/effort picker on Takeover

## Goal

Surface the model/effort picker when promoting an external `claude`
process to an Interactive session via Takeover, so the user can choose
how *our* resume-turn spawns behave.

## Context

Deferred from the model/effort picker design at
`docs/superpowers/specs/2026-05-12-model-effort-picker-design.md`. v1
only shows the picker on the New-session path. Takeover currently
inherits whatever defaults the runner uses, which after v1 means
"reject because model/effort are required" — so we either need a
fallback policy or this UI.

Background: takeover (`chat/takeover.rs`) resolves an external pid's
`session_id` from `~/.claude/sessions/<pid>.json`, kill_tree's the
external, and registers an Interactive entry. After v1 ships, the
Interactive entry needs `model` + `effort` populated before
`send_message` can spawn a resume turn.

v1 short-term fallback (already in spec, see §"Non-Obvious Notes"):
defaults to `opus` + `high` for externally-detected sessions. That
unblocks takeover but isn't user-controlled.

## Approach

Two options, pick one when picking this up:

1. **Modal on takeover click** — reuse `openModelEffortModal(...)`, prefill
   with `projectLastChoice` for the project, default to `Normal` preset.
   Same UI as New-session.

2. **Use last-choice silently + statusbar chip to adjust** — skip the
   modal, populate with `projectLastChoice` (or `Normal` if none), let
   the user adjust effort via the statusbar chip after. Model is locked
   to whatever was preselected.

Option 2 matches the "takeover = one-click" feel of the current flow.
Option 1 is more explicit. Probably option 2 unless Joe disagrees.

## Acceptance

- Takeover from external → Interactive session is spawnable.
- Whichever option is chosen, `Instance.model` and `Instance.effort` are
  populated before the first resume turn runs.
- `projectLastChoice` is honored.
- No regression on the existing takeover happy path (kill_tree + register).
