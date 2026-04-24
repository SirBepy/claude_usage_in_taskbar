# Phase 3 wrap-up checklist — closeout notes (2026-04-24)

## Task 1 status — ABORTED (formatter divergence)

The plan required aborting Task 1 if the three token formatters diverged non-trivially. They do:

| Function | Location | Case | Threshold logic | Null/zero guard | `.0` stripping |
|---|---|---|---|---|---|
| `fmtK` | src/modules/stats.js:10 | uppercase K | `>=10_000` → no decimal; `>=1_000` → 1 decimal | falsy `!n` | no |
| `formatCompactTokens` | src/dashboard.js:794 | lowercase k | `>=1_000` always 1 decimal | none | no |
| `fmtTokens` | src/dashboard.js:909 | lowercase k | `>=1_000` 1 decimal | falsy `!n` | yes |

Example divergence for `n = 15000`:
- `fmtK` → `"15K"` (uppercase, no decimal)
- `formatCompactTokens` → `"15.0k"` (with .0, lowercase)
- `fmtTokens` → `"15k"` (no .0, lowercase)

`grep -rn 'fmtK|fmtTokens|formatCompactTokens' src/ tests/` → **18 hits** (Task 1 is outstanding work).

Unifying these requires a deliberate behavioral choice (which output should win). That decision is out of scope for this run.

## Task 2 status — DONE

MVP-hide `<style>` block extracted from `src/index.html` (was lines 5-24) into `src/styles/mvp-hidden.css`.
Linked via `<link rel="stylesheet" href="./styles/mvp-hidden.css">` after `dashboard.css`.
Vite build clean; tsc clean; test suite unchanged (5 pre-existing failures, 53 passing).

## Widget-extraction audit (Task 3 Step 1)

- `grep -rn 'project-card' src/` → matches only in `src/dashboard.css` (styles) and `src/dashboard.js` (rendering). No cross-view duplication; single-file SPA, not yet migrated to views.
- `grep -rn 'ring-gauge|bar-chart|usage-card' src/` → **zero hits**. These widget names don't exist yet.

## Codebase state note

The plan was written for a post-Phase-3/Phase-4 TypeScript state that does not yet exist in this repo. Current state:

- `src/views/`, `src/shared/`, `src/styles/themes.css` — **do not exist**
- `src/dashboard.js`, `src/dashboard.css`, `src/modules/*.js` — **still present** (legacy JS, not yet deleted)
- `src/styles/mvp-hidden.css` — **created by Task 2 of this run**
- `src/components/` — never existed; plan's assertion that it's "obsolete" is vacuously true

The `src/components/` extraction (old Task 13) is moot: the TypeScript view migration hasn't begun, so there is nothing to extract or consolidate.

## Green checks (this run)

- tsc: clean (no errors)
- Vite build: clean (dist/index.html has no inline `<style>` block; MVP rules in bundled CSS)
- vitest: 53 passed / 5 pre-existing failures (unchanged by this run)
- cargo test: blocked by missing GTK dev headers in this environment (pre-existing CI constraint)
