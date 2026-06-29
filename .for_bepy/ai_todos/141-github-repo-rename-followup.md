# Rename GitHub repo to match Claude Conductor (optional)

## Goal
Optionally rename the GitHub repo `SirBepy/claude_usage_in_taskbar` to match the app's new identity (e.g. `claude-conductor`) and update the in-code URL references to the new slug.

## Context
The app was renamed Claude Usage -> Claude Conductor (v0.2.0, see commit `877b219`). The repo slug AND the project folder were deliberately left as `claude_usage_in_taskbar`: a repo rename is a remote action, and the folder name is a path fixture. GitHub 301-redirects old release URLs, so the auto-updater keeps working even if the repo is renamed, but the URLs read stale.

DO NOT change `src-tauri/src/tokens/walker.rs` — its `claude_usage_in_taskbar -> c--Users-...` strings are derived from the on-disk folder path (Claude Code transcript-dir slug), not the repo name. They'd only change if the actual project FOLDER is renamed (a separate, larger task).

URL reference sites (from the rename inventory):
- `src-tauri/tauri.conf.json:48` — updater endpoint (`releases/latest/download/latest.json`)
- `src/views/settings/subviews/about/about.ts:28` — `releases/tag/v${version}` link
- `src-tauri/src/ipc/misc.rs:163` — GitHub API `releases/tags/v{version}`
- `README.md:16`, `docs/night_run/INDEX.md:4`, `.portfolio-data/metadata.json:8`

## Approach
1. Confirm the new repo name with Joe (remote action — needs consent).
2. `gh repo rename <new-name>` (GitHub sets up the redirect automatically).
3. Update the 6 URL sites above to the new slug. Leave walker.rs untouched.
4. `git remote set-url origin <new-url>`.
5. Verify: `cargo build --manifest-path src-tauri/Cargo.toml` + `npx tsc --noEmit` green; curl the new updater `latest.json` URL and confirm it resolves.

## Acceptance
Repo renamed, all in-code GitHub URLs point at the new slug, the updater `latest.json` URL still resolves, walker.rs path fixtures unchanged, build + typecheck green.
