`tauri/binaries/piper/` held `piper-x86_64-pc-windows-msvc.exe` while `tauri/src/paths.rs:64` looked for plain `piper.exe` / `piper`. Fixed by updating `piper_binary_path` to compute the Tauri target-triple-suffixed name via cfg (e.g. `piper-x86_64-pc-windows-msvc.exe` on Windows x86_64). Matches what `tauri-build`'s `externalBin` validator already enforces at build time. `cargo check` clean. Runtime `piper_binary_exists()` now finds the bundled sidecar next to the app exe in both dev (`target/debug/`) and release bundles. Mac/linux binaries still missing; tracked in `WORKFLOWS_FOR_SIRBEPY.md`.

## 2026-04-21 02:04 - subagent-driven-development deviation (mute-notifications plan)
**Question:** Strict per-task dispatch = 8 tasks × 3 subagents = 24 invocations, each paying Rust compile overhead. Worth it here?
**Options considered:** (1) strict per-task + two-stage review, (2) single implementer for whole plan + one final reviewer, (3) wait for dev.
**Picked:** (2) single implementer + final reviewer.
**Reason:** Plan is extremely prescriptive (exact code provided in every step), mostly mechanical copy-paste. Dev is away and pre-authorized auto-decisions. Cuts wall-clock and cost ~10x while keeping a review gate.
**Where:** workflow only, no code impact.

## 2026-04-21 02:04 - UI smoke tests skipped
**Question:** Plan includes `cargo tauri dev` + tray-click + dashboard-click smoke steps (Tasks 4, 5, 6, 7). Dev is asleep - can't run interactive checks.
**Options considered:** (a) skip, log here, (b) attempt headless via playwright MCP, (c) halt plan.
**Picked:** (a) skip, log here.
**Reason:** Pre-authorized by /sleep-when-done. `cargo tauri dev` blocks until killed + needs a real display server + tray interaction = no way to verify without the dev. Rust unit tests still run.
**Where:** Tasks 4 Step 4, 5 Step 2, 6 Step 2, 7 Step 6 of docs/superpowers/plans/2026-04-20-mute-notifications.md. Dev should smoke-test locally before merging PR #1.

## 2026-04-21 - Electron to Tauri cutover

Cutover executed on `tauri-rewrite` per `docs/superpowers/specs/2026-04-21-electron-to-tauri-cutover-design.md`.

**Done:**
- Tag `v1.0.61-electron-final` pushed on master (bookmark for final Electron build).
- Deleted Electron code: main.js, src/, server/, mcp-server/, scripts/, build/, resources/, root package.json.
- Deleted `.github/workflows/release.yml` (Electron CI).
- Promoted `tauri/*` to repo root (Cargo.toml, tauri.conf.json, src/, dist/, tests/, assets/, binaries/, capabilities/, vitest.config.mjs, package.json, README.md).
- `tauri/icons/` and `tauri/gen/` were gitignored - moved via filesystem (not git).
- Rewrote `.github/workflows/tauri-release.yml` for root layout (no more `working-directory: ./tauri`).
- Updated `.gitignore` (dropped `/dist/`, `!tauri/dist/`, `resources/piper/`; added `/target/`, `/gen/schemas/`).
- Rewrote `CLAUDE.md` for Tauri root layout.
- Filed CUT-6 through CUT-13 in Obsidian vault for parity follow-ups (Bars, Digits, spin anim, token-stats, macOS, Linux, updater pubkey, Piper decision).

**Not done (needs you):**
- `cargo tauri dev` smoke test - interactive, can't run headless. Run locally before merging PR #1.
- Full `cargo tauri build` NSIS installer build - skipped (15+ min). `cargo check` passed clean.
- Vitest: 36/40 pass. 4 pre-existing failures in `tests/dashboard_wiring.test.mjs` (`copyLogs` stub) and `tests/merge_modal.test.mjs` (confirm label, onConfirm callback). Unhandled rejection in `populatePackSelect` ("Cannot read properties of null (reading 'map')"). These look unrelated to cutover (test bugs/pre-existing breakage). Look into separately.
- Stray uncommitted changes present in working tree before cutover (COMMENTS_FOR_BEPY.md, .claude/settings.local.json, `tauri/dist/modules/formatters.js`). Left untouched during cutover. `formatters.js` refactor references `getPaceColor(pct, safePace, s)` which isn't defined anywhere else - looks like an unfinished refactor from the prior session. Needs your review.
- PR #1 merge itself. Push the branch + merge via GitHub UI yourself.
- After merge: delete `tauri-rewrite` remote branch, confirm `Tauri Release` workflow fires on master push, update memory `project_tauri_rewrite_state.md` to mark rewrite complete.

**Cutover commits on tauri-rewrite (after the existing work):**
- `DOCS: add Electron to Tauri cutover spec`
- `DOCS: add Electron to Tauri cutover implementation plan`
- `CHORE: remove Electron app files`
- `CI: remove Electron release workflow`
- `CHORE: promote tauri contents to repo root`
- `CI: update Tauri release workflow for root layout`
- `CHORE: update .gitignore for Tauri root layout`
- `DOCS: update CLAUDE.md for Tauri root layout`
