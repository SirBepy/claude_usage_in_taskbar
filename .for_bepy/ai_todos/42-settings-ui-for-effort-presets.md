# Settings UI for effort presets

## Goal

Add a settings panel where Joe can rename and edit the 3 effort presets
(Light / Normal / Heavy) without hand-editing `settings.json`.

## Dependency

**Do todo 49 first.** `effortPresets` does not exist in `store.rs` or `settings.json` yet. This panel reads/writes that field. Implementing 42 without 49 means building a UI with nothing to back it.

## Context

Deferred from the model/effort picker design at
`docs/superpowers/specs/2026-05-12-model-effort-picker-design.md`. v1 of
that spec writes the 3 presets to `settings.json` under `effortPresets`
and reads them on modal open, but there is no UI affordance — Joe has
to open the JSON to change names or values. The modal itself, runner
plumbing, and `set_session_effort` IPC ship without this panel.

Preset shape (already implemented in v1):

```json
[
  { "name": "Light",  "model": "sonnet", "effort": "low" },
  { "name": "Normal", "model": "opus",   "effort": "high" },
  { "name": "Heavy",  "model": "opus",   "effort": "max" }
]
```

## Approach

Add a "Session presets" subview under Settings (sibling of
`-visuals` / `-themes` / `-notifications`). Three rows, each:

- name text input (max 20 chars)
- model dropdown: `haiku` | `sonnet` | `opus`
- effort dropdown: `low` | `medium` | `high` | `xhigh` | `max`
- delete button is NOT shown — exactly 3 presets, always.

Save on blur or "Save" button (match existing settings panels). Reads
`effortPresets` via `get_settings`, writes via `save_settings`. No new
IPC needed.

Rejected: variable preset count. Keeping it at exactly 3 (matching the
modal's preset row layout) avoids reflow logic in the modal. If Joe
later wants 4–5 presets, revisit modal layout first.

## Acceptance

- Settings → Session presets shows 3 editable rows.
- Edits persist to `settings.json` under `effortPresets`.
- Reopening the new-session modal reflects the new names/values.
- Empty name or invalid model/effort blocks save with an inline error.
- No regression on the new-session modal: opening it with hand-edited
  presets in `settings.json` still works.
