# Electron → Tauri Cutover

**Date:** 2026-04-21
**Branch:** `tauri-rewrite` (PR #1)
**Predecessor spec:** `docs/superpowers/specs/2026-04-19-tauri-rewrite-design.md`

## Goal

Retire the Electron app. The Tauri rewrite on branch `tauri-rewrite` (currently in `tauri/` subfolder) becomes the one and only app at the repo root. Ship the cutover as the PR #1 merge.

## Non-goals

- Feature parity with Electron before cutover. Missing features (tray Bars/Digits, spin animation, token-stats, Piper TTS, macOS/Linux builds) are tracked as follow-up tickets, not blockers.
- Rebuilding the sync backend. Dropped permanently (per Tauri rewrite spec).
- Keeping Electron files around in a `legacy/` folder. Git history is the archive.

## Phase 1 - Tag Electron final on master

Before any deletion, mark the last Electron release so users on v1.0.61 can still be pointed at it.

- Create annotated tag `v1.0.61-electron-final` on `master` HEAD.
- Push tag to origin. No fresh build needed (v1.0.61 was already published by the release.yml workflow).
- The tag is a bookmark only; the GitHub release for v1.0.61 already exists.

## Phase 2 - Restructure on `tauri-rewrite` branch

### Files to delete (Electron-only)

Top level:
- `main.js`
- `src/` (Electron core + renderer)
- `server/` (old sync backend)
- `mcp-server/` (old standalone MCP)
- `scripts/` (Electron icon gen + piper download)
- `build/` (NSIS installer.nsh)
- `resources/` (piper binaries)
- `package.json`, `package-lock.json` (Electron deps)

CI:
- `.github/workflows/release.yml` (Electron release workflow)

### Files to move from `tauri/` to root

Entire `tauri/` contents promote to repo root:
- `src/` (Rust + frontend)
- `dist/` (webview assets)
- `Cargo.toml`, `Cargo.lock`
- `tauri.conf.json`
- `build.rs`
- `capabilities/`
- `icons/`
- `assets/`
- `binaries/`
- `tests/`
- `vitest.config.mjs`
- `package.json`, `package-lock.json` (Tauri vitest-only)
- `gen/` if tracked (schema)
- `tauri/README.md` → `README.md` (overwrite root README)

`tauri/node_modules/`, `tauri/target/` stay gitignored and are not part of the move.

### Files to update (not move)

- `.github/workflows/tauri-release.yml`:
  - Drop `working-directory: ./tauri` from all steps.
  - `jq -r .version tauri/tauri.conf.json` → `jq -r .version tauri.conf.json`.
  - `workspaces: tauri` → `workspaces: .`.
  - Upload paths `tauri/target/release/bundle/nsis/*` → `target/release/bundle/nsis/*`.

- `CLAUDE.md`:
  - Remove Electron architecture table (main.js / src/core / src/renderer rows referring to Electron).
  - Keep Tauri sound-packs and authentication/scraping sections (still accurate).
  - Update file-path references from `tauri/src/soundpacks.rs` → `src/soundpacks.rs`, etc.
  - Replace "Single process: Electron main (`main.js`)" with Tauri equivalent.

- `README.md` (from promoted `tauri/README.md`):
  - Verify dev loop instructions reference root (no `cd tauri`).
  - Update install/build snippets accordingly.

- `.gitignore`:
  - Remove `!tauri/dist/` (no longer needed after move).
  - Change `/dist/` to not exclude the webview assets at new root `dist/` - change rule to ignore only Electron-style `dist/` output, which no longer exists. Simplest: delete the `/dist/` ignore line entirely since Electron's build output dir is gone.
  - Remove `resources/piper/` line (resources dir deleted).

### Files to keep unchanged

- `docs/` (preserves rewrite spec + this cutover spec)
- `LICENSE`
- `COMMENTS_FOR_BEPY.md`
- `WORKFLOWS_FOR_SIRBEPY.md`
- `.claude/` (local settings)

## Phase 3 - Verify

Before merging PR #1, verify from repo root:

1. `cargo tauri dev` boots, tray icon appears, login flow still works.
2. `cargo test --lib` - all 21 Rust tests pass.
3. `npm test` from root (vitest) passes.
4. `cargo tauri build` produces NSIS installer at `target/release/bundle/nsis/*.exe`.

If any of these fail, fix before merge. Do not ship broken cutover.

## Phase 4 - File parity tickets via `/obsidian`

After cutover merges, file follow-up tickets in Obsidian vault for every deferred feature. Each gets its own ticket:

1. Tray `Bars` display mode (currently only `Rings` implemented in `icon.rs`).
2. Tray `Digits` display mode.
3. Spin animation on tray icon during refresh and hook ping.
4. Token-stats JSONL walker for `~/.claude/projects/*.jsonl`.
5. macOS build + bundling.
6. Linux build + bundling.
7. Updater pubkey generation + NSIS installer smoke test.
8. Piper TTS decision (port to Tauri or drop permanently).

These are not part of the cutover PR. They are post-merge backlog.

## Phase 5 - Merge PR #1

PR #1 becomes the cutover PR. Preferred merge strategy: squash (branch has many fine-grained commits; cutover deserves a single master-visible commit).

After merge:
- Delete `tauri-rewrite` branch.
- Confirm `tauri-release.yml` triggers on master push and produces a draft release.
- Update memory `project_tauri_rewrite_state.md` - mark rewrite complete.

## Risks

- **Workflow path breakage:** if `tauri-release.yml` path updates are wrong, first post-cutover release fails. Mitigation: run workflow via `workflow_dispatch` before the final merge if possible, or treat the first post-cutover push as the smoke test.
- **Updater pubkey still placeholder:** tray updater will fail at runtime until real pubkey is generated. Tracked in follow-up #7 but users should not expect auto-updates until then.
- **Git history of Electron code is the only archive:** if someone needs to reference old behavior, they use `git show v1.0.61-electron-final:path/to/file.js`. Document this in README troubleshooting section.
