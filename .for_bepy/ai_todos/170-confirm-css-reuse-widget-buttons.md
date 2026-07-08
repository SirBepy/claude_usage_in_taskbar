# Duplicate: confirm.css button styles vs widgets.css

## Goal
Make the in-app confirm dialog (`src/shared/confirm.ts`) use the existing shared button classes instead of redefining its own.

## Context
`src/shared/confirm.css:38-55` defines a bespoke `.app-confirm .btn` + `.btn.danger` recipe (padding, radius, font, hover, danger tint). `src/styles/widgets.css:511-539` already ships `.btn-primary` / `.btn-secondary` / `.btn-danger` used across the app. The wizard's `add-account-wizard.css` has the same pre-existing duplication (`.aaw-overlay .btn`), so consider whether one shared modal-button style should serve both.

## Approach
Swap `confirm.ts`'s `btn app-confirm-cancel` / `btn app-confirm-ok danger` class assignments to `btn-secondary` / `btn-danger` (keep the `app-confirm-*` marker classes - tests select on them), delete the duplicated rules from confirm.css, and eyeball both the remove-account confirm and the wizard discard confirm for visual regressions.

## Acceptance
- confirm.css no longer contains its own button box/typography rules.
- `pnpm vitest run tests/confirm.test.mjs tests/add-account-wizard-dom.test.mjs` green.
- Both confirm dialogs look correct in the dev app (danger button reads red).
