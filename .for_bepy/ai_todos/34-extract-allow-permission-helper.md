# Extract a shared allowPermission() helper for the repeated respond_permission allow block

## Goal

Collapse the identical "auto-allow this permission prompt" invoke block, now repeated 4x in `permission-modal/index.ts` (plus near-identical copies in `gating.ts::autoAllowIfRemembered` and `permission-card.ts`), into one small helper.

## Context

The exact block
```ts
void invoke("respond_permission", {
  id: payload.id, behavior: "allow", updatedInput: payload.input ?? {}, message: null,
}).catch((e) => console.warn("[auto-accept] ... failed:", e));
```
appears in `src/views/sessions/permission-modal/index.ts` at: the arrival auto-accept path, the new background auto-accept path, `replayPendingPrompt`, and the new `autoAcceptParked`. `grep "behavior: \"allow\""` under `src/` returns 6 hits across index.ts(4) + gating.ts(1) + permission-card.ts(1). The only thing that varies is the warn-log prefix string. This duplication grew this session (2026-06-09) when the background-allow and toggle-drain paths were added for the auto-accept-dot fix.

## Approach

Add `function allowPermission(payload: { id: string; input?: unknown }, logTag: string): void` in `permission-modal/` (gating.ts or a small shared module) that wraps the invoke + `.catch` warn. Replace the 4 index.ts call sites; evaluate folding gating.ts and permission-card.ts too (they may want a slightly different shape - don't force it if it adds branches). Keep `updatedInput: payload.input ?? {}` and `message: null` exactly.

## Acceptance

- One helper; the 4 index.ts duplicates are gone.
- `grep "behavior: \"allow\""` under src/ shows the literal only inside the helper (plus any call sites deliberately left).
- `pnpm tsc --noEmit` clean; vitest still green (auto-accept tests unaffected).
