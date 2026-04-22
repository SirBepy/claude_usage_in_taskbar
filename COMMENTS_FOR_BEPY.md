## 2026-04-22 03:30 - Theme-variable plan/reality mismatch
Plans A/B/C prescribed CSS vars that don't exist here (`--bg-elevated`, `--bg-hover`, `--bg-active`, `--text-strong`, `--accent`, `--bg-sunken`). Substituted inline during each task:
- `--bg-elevated` → `--surface`
- `--bg-hover` / `--bg-active` → `--surface-alt`
- `--text-strong` → `--text`
- `--accent` → `--primary`
- `--bg-sunken` → `--bg`

Plan docs in `docs/superpowers/plans/` still have the wrong names. Cleanup if re-referenced.

## 2026-04-22 03:30 - Carry-forward tech debt (from Plans A/B/C reviews)
None blocking. Triage yours.

1. `dist/modules/stats.js` has ~6 legacy `renderStats(lastTokenHistory)` call sites that silently no-op since Plan A Task 12 removed `#stats-table-container`. Project rename/save in detail view won't refresh Projects card list until `onTokenHistoryUpdated` fires. Fix: swap to `if (typeof renderProjectsList === 'function') renderProjectsList();`.
2. `escapeProjHtml` in `dist/dashboard.js` doesn't escape single quotes. Current call sites all use double-quoted attrs so low-risk. Add `"'": "&apos;"` to map.
3. `update_project` IPC in `src/ipc.rs` returns same `"project {id} not found"` for missing ID and invalid patch. Frontend can't distinguish. Split errors.
4. No SRI on Phosphor CDN `<script>` in `dashboard.html` / `tauri.conf.json`. Tauri app + third-party JS + `window.__TAURI__.core.invoke` = attack surface. Add `integrity="sha384-..."` + `crossorigin="anonymous"`.
5. `renderRunningInstances` labels all non-automated instances "External" regardless of `kind`. Fine today (enum has 2 variants). Bug if Plan D adds a third.
6. Plan files in `docs/superpowers/plans/` still reference wrong theme-var names (dup of above).
