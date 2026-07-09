# src/views/sessions/model-effort-modal.ts should extract its character-pane logic

## Goal
Split the character-picker sub-feature out of `openModelEffortModal` so the 466-line file's remaining bulk is just the model/effort form itself.

## Context
`src/views/sessions/model-effort-modal.ts` is 466 lines. It was already trimmed once today (commit 53aaa4c7 extracted the account-field UI into `account-field.ts`), but the character-pane logic - `pickCharacter` (model-effort-modal.ts:123-144), `renderCharPane` (146-208), and `attachCharHandlers` (210-244), plus the module-level `iconCache`/`pool`/`character` state they share - is a self-contained sub-feature (~120 lines) with a narrow surface: it reads `projectId` and the live-taken session set, and writes into `.me-char-pane`. It mirrors exactly the shape of the account-field extraction that already happened for this same file.

## Approach
Extract a `character-pane.ts` module (in `src/views/sessions/`) exposing something like a small class or a factory function `createCharacterPane(overlay, projectId, onPick)` that owns `pool`/`character`/`iconCache` and renders into `.me-char-pane`, mirroring how `account-field.ts` owns `AccountFieldState` and is wired via `renderAccountFieldHtml`/`attachAccountFieldHandlers`. `model-effort-modal.ts` keeps only the model/effort slider form, presets, and the account-field wiring.

## Acceptance
`model-effort-modal.ts` drops by ~120 lines; `pnpm tsc --noEmit` passes; opening the new-session modal still shows a random character, reroll and "Choose" character both work, and the picked character is still passed through in the returned `SessionConfig`.
