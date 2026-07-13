# Serve PR-review git IPC from the daemon so the phone PWA can browse PR files

**Type:** task

## Goal

Make the PR modal's Commits / Files Changed browsing work in the remote phone view. Today the two git commands only exist as Tauri commands, so the phone PWA (daemon-served) gets the "Files unavailable" fallback while the Description tab still works.

## Context

- Shipped 2026-07-13: `get_range_files` + `get_file_diff` in `src-tauri/src/ipc/git.rs` (registered in `lib.rs` generate_handler), consumed by `src/shared/chat/pr-review-modal.ts` via `invoke`.
- The daemon is a separate OS process; remote clients hit `remote_server.rs` (:27183), which serves its own command surface - Tauri generate_handler commands are NOT automatically available there (same gap that ai_todo 241 fixed for `list_accounts`).
- The frontend already degrades gracefully (muted "Files unavailable outside a project session" state), so this is purely additive.

## Approach

1. Follow the `list_accounts`-over-remote-API pattern from commit cd831041: expose the two git functions through the daemon's remote command routing (the pure logic in `git.rs` is already `pub async fn(cwd, from, to, ...)`; factor the body so both the Tauri command and the daemon route call one shared function if the crates split makes that necessary).
2. Confirm the phone-side `invoke` shim routes those names over the remote API.
3. Security note: cwd comes from the session registry on the daemon side - do not let the remote client pass arbitrary cwd; resolve it from the session like other remote endpoints do.

## Acceptance

- Phone PWA (headless daemon on :27183 + Playwright mobile profile per project memory) can open a PR card, see commit file counts, the whole-PR file list, and per-file diffs.
- Desktop behavior unchanged; `cargo test --lib` stays green.
- No arbitrary-path git execution reachable from the remote surface.
