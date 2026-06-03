# Reconcile the two model-name formatters

## Goal
Two model-name display helpers exist with divergent output. Decide on one canonical formatter (or two clearly-named ones) instead of near-duplicates.

## Context
- `src/views/sessions/session-statusbar.ts:51` `shortModelName("claude-opus-4-7")` -> `"Opus 4.7"` (keeps version, capitalized).
- `src/views/session-detail/session-detail.ts` `shortModel("claude-opus-4-8")` -> `"opus"` (drops version, lowercase) - added this session for the chat-detail model/effort line + reused intent for running-instance rows.
They overlap conceptually (collapse a full model id to a readable label) but produce different strings, so it's NOT a drop-in dedupe - confirm which output each surface actually wants before merging. The chat-detail/instance-row context shows a bare family ("opus"); the statusbar shows "Opus 4.7".

## Approach
- Decide: do the chat-detail + instance rows want the version too (then reuse `shortModelName`)? Or is bare-family intentional (then keep both but move them to one shared `src/shared/` module with distinct names, e.g. `modelFamily()` vs `modelLabel()`)?
- Put the chosen helper(s) in a shared module (`src/shared/`), delete the per-view copies, update imports.

## Acceptance
- No duplicated model-name shortener logic across views; one shared module owns it.
- Visible labels unchanged unless intentionally reconciled.
- `tsc --noEmit` (no new errors), `vite build` green.
