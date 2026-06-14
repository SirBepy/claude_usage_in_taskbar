# Optional: add a subtle slide-up to the chat-open reveal

## Goal
If the pure fade-in on chat open reads a touch flat, add a small upward slide so the transcript settles into place as it fades. ONLY do this if Joe says the fade alone feels lifeless after seeing it live; otherwise leave as-is.

## Context
Chat open now holds the transcript hidden during build and fades it in (opacity 0->1, 150ms) once folded/pinned/highlighted. Implemented in `src/shared/chat/chat-renderer.ts`:
- `beginRevealHold()` sets `opacity:0; transition:none` at build start.
- `revealTranscript()` sets `transition: opacity 150ms ease; opacity:1`.
This was the "A" (fade-only) choice; "B" was fade + subtle slide. Joe picked "either A or B" and may want B's motion after seeing A.

## Approach
In `revealTranscript()`, animate `transform: translateY(8px) -> translateY(0)` alongside opacity:
- `beginRevealHold()`: also set `transform: translateY(8px)`.
- `revealTranscript()`: transition both, e.g. `transition: opacity 150ms ease, transform 180ms ease; opacity:1; transform: translateY(0)`.
Keep it subtle (6-10px). Clear the inline `transform` in `detach()` alongside the opacity reset so an aborted load leaves no residual offset.

## Acceptance
- On chat open the transcript fades AND slides up a few px into place, once, smoothly.
- No residual transform after switching sessions or aborting a load.
- `pnpm exec vitest run tests/chat-pagination-fold.test.mjs` and `pnpm tsc --noEmit` stay green (extend the reveal test's opacity assertion with a transform check if you add it).
