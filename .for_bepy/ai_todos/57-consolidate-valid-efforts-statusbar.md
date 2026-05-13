# Consolidate VALID_EFFORTS array between statusbar and presets modules

## Goal
After ai_todo 56 lands (shared `effort-presets.ts`), drop the `VALID_EFFORTS` constant in `session-statusbar.ts` and import `EFFORTS` from the shared module instead.

## Context
`src/views/sessions/session-statusbar.ts` declares its own
```ts
const VALID_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
```
which mirrors `EFFORTS` in `model-effort-modal.ts` and `presets.ts`. The statusbar uses the constant only for slider stops and indexing, so it is interchangeable with the shared `EFFORTS`.

## Approach
1. Depend on ai_todo 56 being merged first (the shared module must exist).
2. In `src/views/sessions/session-statusbar.ts`:
   - Replace `const VALID_EFFORTS = [...] as const;` with `import { EFFORTS } from "../../shared/effort-presets";`
   - Update every `VALID_EFFORTS` reference to `EFFORTS`.
3. Run `npx tsc --noEmit`.

## Acceptance
- `VALID_EFFORTS` no longer appears in `src/views/sessions/session-statusbar.ts`.
- All effort-stop rendering and slider logic still works identically.
- `npx tsc --noEmit` clean.
