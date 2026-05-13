# Extract shortcuts section from settings.ts

## Goal
Split `renderShortcutsSection` out of `settings.ts` into its own `settings-shortcuts.ts` file to bring `settings.ts` under 300 lines.

## Context
`settings.ts` is 429 lines. `renderShortcutsSection` (lines 169-311, ~143 lines) is a fully self-contained unit with its own state type (`ShortcutsUIState`), its own re-render closure, capture/stop helpers, and event wiring. It has no dependencies on the rest of `settings.ts` except the `shortcuts` import. Clear split boundary at line 169.

## Approach
1. Create `src/views/settings/settings-shortcuts.ts`.
2. Move `ShortcutsUIState`, `renderShortcutsSection`, and its inner helpers into it. Export `renderShortcutsSection`.
3. In `settings.ts`, replace the moved code with `import { renderShortcutsSection } from "./settings-shortcuts"`.
4. Verify `cargo tauri dev` still renders the Shortcuts section in Settings with all rebind/reset/checkbox interactions working.

## Acceptance
- `settings.ts` under 300 lines.
- Shortcuts section renders, rebind/reset/slot-mode checkbox all work.
- No TypeScript errors.
