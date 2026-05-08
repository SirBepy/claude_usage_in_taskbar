# Extract SessionStatusbar to its own module

## Goal

Move the `SessionStatusbar` class out of `sessions.ts` into `src/views/sessions/session-statusbar.ts` to bring `sessions.ts` below 800 lines and give the statusbar a clean, importable module boundary.

## Context

`sessions.ts` is 1216 lines after the 2026-05-08 statusbar session. The `SessionStatusbar` class (plus its helpers `DEFAULT_STATUSLINE_FIELDS`, `ALL_STATUSLINE_FIELDS`, `loadStatuslineFields`, `saveStatuslineFields`, `shortModelName`, `formatDuration`) occupies roughly lines 1050-1216 and has no dependencies on `sessions.ts` internals beyond the `invoke` import and the `escapeHtml` helper (which should move with it or be inlined).

Relevant commit: `aa3b68d FEAT: session statusbar with model, branch, context, thinking, cost chips`.

## Approach

1. Create `src/views/sessions/session-statusbar.ts`.
2. Move these items from `sessions.ts` into the new file:
   - `DEFAULT_STATUSLINE_FIELDS`, `ALL_STATUSLINE_FIELDS`
   - `loadStatuslineFields`, `saveStatuslineFields`
   - `shortModelName`, `formatDuration`
   - `SessionStatusbar` class (keep the `escapeHtml` local copy or import from a shared util)
3. Export `SessionStatusbar` and `loadStatuslineFields` (needed by `sessions.ts`).
4. In `sessions.ts`: replace the moved block with an import.
5. No behavior change. TypeScript check must pass clean (`npx tsc --noEmit`).

`escapeHtml` already exists in `sessions.ts` - either duplicate it in the new file (simple) or extract it to `src/shared/utils.ts` first (cleaner but separate task).

## Acceptance

- `npx tsc --noEmit` exits 0 (ignoring the pre-existing `AutoUpdateMode` error in `ipc.generated.ts`).
- `sessions.ts` is under 1000 lines.
- `session-statusbar.ts` contains all moved items.
- `cargo tauri dev` builds and the statusbar renders correctly in a live session.
