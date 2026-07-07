# Extract the account-picker UI section out of model-effort-modal.ts

## Goal
Pull the multi-account "account picker" rendering/state block out of `src/views/sessions/model-effort-modal.ts` into its own module, mirroring the existing `account-picker-logic.ts` split that already extracted the pure resolution logic.

## Context
`src/views/sessions/model-effort-modal.ts` was 400 lines before this feature and is now 544 lines (net +144, see `git diff --numstat @{u}..HEAD -- src/views/sessions/model-effort-modal.ts`). The growth is almost entirely the new account-picker section added for multi-account milestone 04, which is already visibly self-contained:

- State: `accountId`, `editingAccount`, `remember` (model-effort-modal.ts:112-114) plus the `accountPickIncomplete()` helper (model-effort-modal.ts:120-122).
- Rendering: `accountHintHtml()` (model-effort-modal.ts:265-275) and `renderAccountFieldHtml()` (model-effort-modal.ts:277-318), both pure string builders that only read the state above plus `accounts`/`preferredAccountId`/`resolvedAccountId`.
- Wiring: the "── Account picker ──" handler block (model-effort-modal.ts:418-438).

This is the same shape as the file's existing character-pane section (`pickCharacter`/`renderCharPane`/`attachCharHandlers`, model-effort-modal.ts:130-254), which is already visually delimited by its own `── ... ──` banner comment - the account-picker section just hasn't been pulled out into its own file the way `account-picker-logic.ts` already pulled out `resolveInitialAccountId`/`shouldOfferRemember`.

## Approach
Add an `account-field.ts` (or similar) alongside `account-picker-logic.ts` exporting a small render/attach pair (e.g. `renderAccountFieldHtml(state)` and `attachAccountFieldHandlers(overlay, state, onChange)`), and have `model-effort-modal.ts` call into it the same way it already delegates pure logic to `account-picker-logic.ts`. Keep the state (`accountId`, `editingAccount`, `remember`) owned by the modal's closure and pass it in/out, matching the pattern the character pane already uses for its own local state.

## Acceptance
- `pnpm tsc --noEmit` passes.
- `src/views/sessions/model-effort-modal.ts` drops back to roughly its pre-feature size (~400 lines or less).
- Existing behavior (account chip row, "change" toggle, "remember" checkbox, empty-registry CTA) is unchanged - verify via `tests/account-picker-logic.test.mjs` and a manual new-chat run with 0/1/2+ registered accounts.
