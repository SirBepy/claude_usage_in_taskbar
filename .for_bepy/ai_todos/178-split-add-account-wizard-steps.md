# add-account-wizard.ts's openAddAccountWizard should be split by step

## Goal
Break the single 475-line `openAddAccountWizard` function in `src/views/settings/subviews/accounts/add-account-wizard.ts` (add-account-wizard.ts:34-509) into one function per wizard step instead of one function owning all four steps' render + wire logic via closures.

## Context
`add-account-wizard.ts` is 509 lines and effectively one exported function. It already has the right seam internally - four step-scoped render functions (`renderCreateStep` add-account-wizard.ts:149, `renderCookieStep` add-account-wizard.ts:165, `renderLoginStep` add-account-wizard.ts:198, `renderFinalizeStep` add-account-wizard.ts:235) plus matching wiring branches in `render()` (add-account-wizard.ts:304-347, one `if/else if` per step) - but all four are nested closures inside the single `openAddAccountWizard` function because they close over ~15 mutable `let` bindings (`step`, `busy`, `error`, `nameInput`, `sessionId`, `verifiedIdentity`, etc., add-account-wizard.ts:41-60+) rather than an explicit state object.

## Approach
Introduce a single mutable state object (e.g. `const state: WizardState = { step: "create", busy: false, ... }`) and move each `render*Step`/wiring pair into its own top-level function taking `(state, overlay, callbacks)` instead of closing over the outer function's locals. `openAddAccountWizard` then becomes a thin orchestrator: create state, call the right step module's render+wire based on `state.step`, resolve/reject the promise. This mirrors the pattern `wizard-logic.ts` already uses for the pure-logic half of this file.

## Acceptance
- `pnpm tsc --noEmit` passes.
- `openAddAccountWizard` drops to roughly under 100 lines; each step's render+wire logic lives in its own function (same file or split into `add-account-wizard-steps.ts` if that reads cleaner).
- `tests/add-account-wizard-dom.test.mjs` and `tests/add-account-wizard-logic.test.mjs` pass unmodified - no behavior change to the create/cookie/login/finalize flow.
