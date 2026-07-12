# Extract composer push-to-talk into its own controller

**Type:** task

## Goal
Move the push-to-talk (PTT) handling out of `composer.ts` into a dedicated small controller, mirroring how `ComposerVoice` (`src/shared/chat/voice/composer-voice.ts`) already extracts dictation state from the composer.

## Context
`src/shared/chat/composer.ts` is 911 lines and mixes render, drafts, attachments, dictation, scheduling, blocks, and now PTT. This session added ~5 document-level handlers (`_pttKeydown`, `_pttKeyup`, `_pttMousedown`, `_pttMouseup`, `_pttBlur`), the `_pttActive` field, and their add/removeEventListener wiring in the constructor/destroy. They're a self-contained concern with a clean seam.

## Approach
Create `src/shared/chat/voice/composer-ptt.ts` exporting a small class (e.g. `ComposerPtt`) that takes callbacks `{ start(pos), stop(), isMobile() }` (or a ref to `ComposerVoice` + the composer's `currentInsertPos`/`isMobileViewport`), owns the document listeners, and exposes `mount()`/`destroy()`. Composer constructs it once and delegates. Binding read stays via `getPttBinding()` in `push-to-talk.ts` so live edits still apply.

## Acceptance
- `composer.ts` no longer holds the `_ptt*` handlers or `_pttActive`; it delegates to the new controller.
- Hold-to-record / release-to-stop still works (bound key and mouse side-button), and blur/destroy still stop an in-flight recording.
- `pnpm tsc --noEmit` passes.
