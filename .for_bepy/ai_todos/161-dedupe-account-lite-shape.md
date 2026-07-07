# Share one AccountLite-shaped type instead of three copies

## Goal
Replace the three independently-declared "lite account" TypeScript interfaces (same 4 fields) with one shared type.

## Context
Three new files introduced by the multi-account feature each declare their own local interface with the exact same four fields (`id`, `label`, `icon`/`colour` in some order):

- `src/views/dashboard/account-selector-logic.ts:10-15` - `export interface AccountLite { id: string; label: string; icon: string; colour: string; }`
- `src/views/sessions/account-picker-logic.ts:7-12` - `export interface AccountLite { id: string; label: string; icon: string; colour: string; }` (identical field-for-field)
- `src/views/overlay/overlay-logic.ts:13-18` - `export interface OverlayAccountLite { id: string; label: string; colour: string; icon: string; }` (same fields, different declaration order)

`account-picker-logic.ts`'s own header comment even says it "Mirrors the dashboard/account-selector-logic.ts pattern" and `overlay-logic.ts`'s header says it "Mirrors the account-selector-logic.ts split" - the parallel structure was noticed each time but the type itself was re-declared rather than imported. The real `Account` type (`src/shared/api.ts`, re-exported from the Rust `ts_rs` generated types) is a structural superset of all three, so any of these call sites could use `Pick<Account, "id" | "label" | "icon" | "colour">` (or a single hand-rolled `AccountLite`) from one place instead.

## Approach
Add one `AccountLite` type (e.g. in `src/shared/account-chip.ts`, which already owns the closely-related `AccountChipInfo` shape, or directly in `src/shared/api.ts` next to `Account`) and have `account-selector-logic.ts`, `account-picker-logic.ts`, and `overlay-logic.ts` import it instead of redeclaring it. `OverlayAccountLite`'s field order differs but TS interfaces are structural, so this is a drop-in rename with no behavior change.

## Acceptance
- `pnpm tsc --noEmit` passes.
- Only one interface declaration for this 4-field shape remains; the other two/three files import it.
- `tests/account-selector-logic.test.mjs`, `tests/account-picker-logic.test.mjs`, and `tests/overlay-logic.test.mjs` still pass unmodified (the shape doesn't change, only its source module).
