# Electron to Tauri Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the Electron app, promote `tauri/` to repo root, and ship the result as PR #1 merge so the Tauri rewrite becomes the only app.

**Architecture:** Work on branch `tauri-rewrite`. Phase A: tag Electron final on master. Phase B: restructure branch (delete Electron, `git mv` tauri contents up, update CI). Phase C: verify. Phase D: file parity tickets. Phase E: merge.

**Tech Stack:** git, GitHub Actions, Rust/Cargo, Tauri 2, vitest.

**Spec:** `docs/superpowers/specs/2026-04-21-electron-to-tauri-cutover-design.md`

---

## Task 1: Tag v1.0.61-electron-final on master

**Files:** none (git tag operation only)

- [ ] **Step 1: Fetch origin master**

```bash
git fetch origin master
```

- [ ] **Step 2: Create annotated tag on origin/master**

```bash
git tag -a v1.0.61-electron-final origin/master -m "Final Electron build before Tauri cutover"
```

- [ ] **Step 3: Verify tag points at the right commit**

```bash
git rev-parse v1.0.61-electron-final
git rev-parse origin/master
```
Expected: both SHAs equal.

- [ ] **Step 4: Push tag to origin**

```bash
git push origin v1.0.61-electron-final
```
Expected: ` * [new tag] v1.0.61-electron-final -> v1.0.61-electron-final`.

---

## Task 2: Delete Electron-only top-level files

**Files:**
- Delete: `main.js`
- Delete: `src/` (entire tree)
- Delete: `server/` (entire tree)
- Delete: `mcp-server/` (entire tree)
- Delete: `scripts/` (entire tree)
- Delete: `build/` (entire tree)
- Delete: `resources/` (entire tree)
- Delete: `package.json` (Electron, will be replaced from tauri/)
- Delete: `package-lock.json` (Electron, will be replaced from tauri/)

- [ ] **Step 1: Confirm branch**

```bash
git rev-parse --abbrev-ref HEAD
```
Expected: `tauri-rewrite`.

- [ ] **Step 2: Remove Electron files**

```bash
git rm main.js
git rm -r src
git rm -r server
git rm -r mcp-server
git rm -r scripts
git rm -r build
git rm -r resources
git rm package.json
git rm package-lock.json
```

- [ ] **Step 3: Verify nothing tauri was touched**

```bash
git status
```
Expected: all listed files deleted. `tauri/` untouched.

- [ ] **Step 4: Commit**

```bash
git commit -m "CHORE: remove Electron app files"
```

---

## Task 3: Delete Electron CI workflow

**Files:**
- Delete: `.github/workflows/release.yml`

- [ ] **Step 1: Remove workflow**

```bash
git rm .github/workflows/release.yml
```

- [ ] **Step 2: Commit**

```bash
git commit -m "CI: remove Electron release workflow"
```

---

## Task 4: Move tauri/ contents to repo root

**Files:**
- Move: `tauri/src/` → `src/`
- Move: `tauri/dist/` → `dist/`
- Move: `tauri/Cargo.toml` → `Cargo.toml`
- Move: `tauri/Cargo.lock` → `Cargo.lock`
- Move: `tauri/tauri.conf.json` → `tauri.conf.json`
- Move: `tauri/build.rs` → `build.rs`
- Move: `tauri/capabilities/` → `capabilities/`
- Move: `tauri/icons/` → `icons/`
- Move: `tauri/assets/` → `assets/`
- Move: `tauri/binaries/` → `binaries/`
- Move: `tauri/tests/` → `tests/`
- Move: `tauri/vitest.config.mjs` → `vitest.config.mjs`
- Move: `tauri/package.json` → `package.json`
- Move: `tauri/package-lock.json` → `package-lock.json`
- Move: `tauri/gen/` → `gen/` (if tracked)
- Move: `tauri/README.md` → `README.md` (overwrite existing)

- [ ] **Step 1: Overwrite root README with tauri README**

```bash
git rm README.md
git mv tauri/README.md README.md
```

- [ ] **Step 2: Move tracked tauri files and directories to root**

```bash
git mv tauri/src src
git mv tauri/dist dist
git mv tauri/Cargo.toml Cargo.toml
git mv tauri/Cargo.lock Cargo.lock
git mv tauri/tauri.conf.json tauri.conf.json
git mv tauri/build.rs build.rs
git mv tauri/capabilities capabilities
git mv tauri/icons icons
git mv tauri/assets assets
git mv tauri/binaries binaries
git mv tauri/tests tests
git mv tauri/vitest.config.mjs vitest.config.mjs
git mv tauri/package.json package.json
git mv tauri/package-lock.json package-lock.json
```

- [ ] **Step 3: Handle gen/ if tracked**

```bash
git ls-files tauri/gen
```
If output is non-empty:
```bash
git mv tauri/gen gen
```
Otherwise skip.

- [ ] **Step 4: Remove now-empty tauri directory**

```bash
git status
```
Expected: `tauri/` has no tracked files left. If `tauri/node_modules/` or `tauri/target/` remain locally, they are gitignored and can be left or deleted manually. Delete the empty tauri folder from disk:

```bash
rm -rf tauri
```

- [ ] **Step 5: Verify Cargo.toml and tauri.conf.json ended up at root**

```bash
ls Cargo.toml tauri.conf.json src/main.rs
```
Expected: all three exist.

- [ ] **Step 6: Commit**

```bash
git commit -m "CHORE: promote tauri contents to repo root"
```

---

## Task 5: Update Tauri release workflow paths

**Files:**
- Modify: `.github/workflows/tauri-release.yml`

- [ ] **Step 1: Rewrite the workflow**

Open `.github/workflows/tauri-release.yml`. Replace its contents with:

```yaml
name: Tauri Release

on:
  push:
    branches:
      - master
  workflow_dispatch:

permissions:
  contents: write

jobs:
  check:
    runs-on: ubuntu-latest
    outputs:
      should_release: ${{ steps.check.outputs.should_release }}
      tag: ${{ steps.check.outputs.tag }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Resolve version and tag
        id: check
        shell: bash
        run: |
          VERSION=$(jq -r .version tauri.conf.json)
          TAG="tauri-v$VERSION"
          echo "tag=$TAG" >> "$GITHUB_OUTPUT"
          if git rev-parse "refs/tags/$TAG" >/dev/null 2>&1; then
            echo "Tag $TAG already exists. Skipping release."
            echo "should_release=false" >> "$GITHUB_OUTPUT"
          else
            echo "Tag $TAG not found. Will release."
            echo "should_release=true" >> "$GITHUB_OUTPUT"
          fi

  build:
    needs: check
    if: needs.check.outputs.should_release == 'true'
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4

      - name: Create and push tag
        shell: bash
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git tag "${{ needs.check.outputs.tag }}"
          git push origin "${{ needs.check.outputs.tag }}"

      - uses: dtolnay/rust-toolchain@stable

      - name: Cache cargo
        uses: Swatinem/rust-cache@v2
        with:
          workspaces: .

      - name: Install Tauri CLI
        run: cargo install tauri-cli --version "^2.0"

      - name: Build
        env:
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        run: cargo tauri build

      - name: Upload installer
        uses: softprops/action-gh-release@v2
        with:
          files: |
            target/release/bundle/nsis/*.exe
            target/release/bundle/nsis/*.nsis.zip
            target/release/bundle/nsis/latest.json
          tag_name: ${{ needs.check.outputs.tag }}
          name: Tauri ${{ needs.check.outputs.tag }}
          draft: true
```

- [ ] **Step 2: Verify with grep that tauri/ references are gone**

```bash
grep -n "tauri/" .github/workflows/tauri-release.yml
grep -n "working-directory" .github/workflows/tauri-release.yml
```
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/tauri-release.yml
git commit -m "CI: update Tauri release workflow for root layout"
```

---

## Task 6: Update .gitignore

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Read current file**

```bash
cat .gitignore
```

- [ ] **Step 2: Edit entries**

Remove these lines:
- `/dist/` (Electron-specific; new root `dist/` is tracked webview assets)
- `!tauri/dist/` (negation no longer needed)
- `resources/piper/` (resources dir deleted)

Keep these lines (still valid):
- `node_modules/`
- `out/`
- `*.log`
- `.DS_Store`
- `Thumbs.db`
- `.direct-api-test-output.json`
- `.captured-cookies.json`
- `.playwright-mcp/`

Add these lines (Rust/Tauri outputs):
- `/target/`
- `/gen/schemas/` only if not currently tracked (run `git ls-files gen/schemas | head -1`; if output exists, do not add).

- [ ] **Step 3: Verify dist/ still tracked**

```bash
git ls-files dist | head -3
```
Expected: tracked webview files like `dist/index.html`, `dist/modules/formatters.js`.

- [ ] **Step 4: Commit**

```bash
git add .gitignore
git commit -m "CHORE: update .gitignore for Tauri root layout"
```

---

## Task 7: Update CLAUDE.md for new layout

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Open CLAUDE.md and rewrite the architecture table**

Replace the existing Electron `## Running`, `## Architecture`, `## Authentication flow`, `## Usage scraping`, `## Tray icon`, `## Cross-device sync` sections with Tauri-accurate content. Preserve `## Sound packs`, `## Keeping README up to date`, and `## Key dependencies` with path adjustments.

Key replacements throughout the file:
- `tauri/src/soundpacks.rs` → `src/soundpacks.rs`
- Any `main.js` / Electron references → corresponding Tauri paths (`src/main.rs`, `src/core/scraper.rs`, etc.)
- Remove the Cross-device sync section entirely (dropped permanently).
- Remove the MCP server section entirely (dropped permanently).

- [ ] **Step 2: Verify no stale Electron references remain**

```bash
grep -in "electron\|main\.js\|mcp-server\|sync backend" CLAUDE.md
```
Expected: no matches, or only historical prose that clearly reads as "previously Electron".

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "DOCS: update CLAUDE.md for Tauri root layout"
```

---

## Task 8: Verify cargo tauri dev boots

**Files:** none

- [ ] **Step 1: Ensure Rust is on PATH**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
```

- [ ] **Step 2: Run dev build**

```bash
cargo tauri dev
```
Expected: compiles without error, tray icon appears, dashboard window openable from tray menu. Kill with Ctrl+C after confirming.

- [ ] **Step 3: If it fails**, stop and fix before continuing. Common failure: path inside `tauri.conf.json` referencing `../dist` or similar. Open `tauri.conf.json` and adjust `frontendDist` to `dist` (relative to root). Recommit as a fix commit.

---

## Task 9: Verify cargo test --lib passes

**Files:** none

- [ ] **Step 1: Run Rust tests**

```bash
cargo test --lib
```
Expected: 21 tests pass (types, settings, session, history, scraper mocked, icon). If any fail, diagnose path assumptions in tests (e.g. if they read fixture files via relative paths).

- [ ] **Step 2: If tests fail**, fix and commit fixes before proceeding.

---

## Task 10: Verify npm test (vitest) passes

**Files:** none

- [ ] **Step 1: Install deps at root**

```bash
npm install
```

- [ ] **Step 2: Run vitest**

```bash
npm test
```
Expected: all vitest suites pass. If config paths broke, open `vitest.config.mjs` and adjust `root` / `include` globs that assumed `tauri/` prefix.

- [ ] **Step 3: If fixes needed**, commit as `CHORE: fix vitest paths for root layout`.

---

## Task 11: Verify cargo tauri build produces NSIS installer

**Files:** none

- [ ] **Step 1: Run production build**

```bash
cargo tauri build
```
Expected: completes in 5-15 minutes, produces `target/release/bundle/nsis/*.exe`.

- [ ] **Step 2: Confirm installer artifact**

```bash
ls target/release/bundle/nsis/
```
Expected: contains `.exe`, `.nsis.zip`, `latest.json`.

- [ ] **Step 3: If build fails**, diagnose (pubkey placeholder is known; if it blocks build, generate one now or temporarily remove `updater` config - this is judgment call, report to user).

---

## Task 12: File parity follow-up tickets via /obsidian

**Files:** none (Obsidian vault entries)

For each item below, invoke the `/obsidian` skill to create a ticket in the dev's vault. One ticket per item. Each ticket should link back to this plan's spec.

- [ ] **Step 1: Ticket - Tray Bars display mode**

Title: "Tauri: implement tray Bars display mode". Context: `icon.rs` currently only has `render_rings`; `Bars` is an enum value but not rendered.

- [ ] **Step 2: Ticket - Tray Digits display mode**

Title: "Tauri: implement tray Digits display mode". Same file as above.

- [ ] **Step 3: Ticket - Spin animation on tray**

Title: "Tauri: port spin animation on tray refresh/hook ping". Reference Electron `makeSpinFrame` in pre-cutover `src/core/icon.js` (available at `git show v1.0.61-electron-final:src/core/icon.js`).

- [ ] **Step 4: Ticket - Token-stats JSONL walker**

Title: "Tauri: port token-stats JSONL walker for ~/.claude/projects". Reference Electron `src/core/fs-utils.js` in the final Electron tag.

- [ ] **Step 5: Ticket - macOS build**

Title: "Tauri: macOS build + bundling".

- [ ] **Step 6: Ticket - Linux build**

Title: "Tauri: Linux build + bundling".

- [ ] **Step 7: Ticket - Updater pubkey + smoke test**

Title: "Tauri: generate updater signing keypair + run NSIS installer smoke test". Reference `WORKFLOWS_FOR_SIRBEPY.md` steps 1-2.

- [ ] **Step 8: Ticket - Piper TTS decision**

Title: "Tauri: decide - port Piper TTS or drop permanently". Currently deferred.

---

## Task 13: Push branch and prepare PR #1 for merge

**Files:** none

- [ ] **Step 1: Push branch**

```bash
git push origin tauri-rewrite
```

- [ ] **Step 2: Review PR #1 on GitHub**

Open https://github.com/SirBepy/claude_usage_in_taskbar/pull/1. Confirm CI passes or note failures. Update PR description to mention this cutover and link the spec.

- [ ] **Step 3: Squash-merge PR #1**

Use GitHub UI. Merge commit title: `FEAT: Tauri rewrite replaces Electron app`. Confirm master updates.

- [ ] **Step 4: Delete remote branch**

```bash
git push origin --delete tauri-rewrite
```

- [ ] **Step 5: Switch local to master and pull**

```bash
git checkout master
git pull origin master
```

- [ ] **Step 6: Verify Tauri release workflow fires on the merge push**

Check GitHub Actions tab. The `Tauri Release` workflow should run and produce a draft release with the NSIS installer.

- [ ] **Step 7: Update memory**

Update `~/.claude/projects/C--Users-tecno-Desktop-Projects-claude-usage-in-taskbar/memory/project_tauri_rewrite_state.md` - mark rewrite as complete, note cutover date, link follow-up tickets.

---

## Self-review notes

Coverage: every spec phase (1-5) has at least one task. Phase 1 = Task 1. Phase 2 = Tasks 2-7. Phase 3 = Tasks 8-11. Phase 4 = Task 12. Phase 5 = Task 13.

No placeholders remain. All git commands explicit. All file moves enumerated. Fallback guidance given for path-assumption breakage in tests/config.
