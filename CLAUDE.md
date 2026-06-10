@~/.claude/snippets/full-auto.md

# Claude Companion

Cross-platform Tauri 2 app (Rust + vanilla JS webview). Usage monitoring via CDP-driven Chrome scraping, interactive Claude chat sessions (daemon-hosted persistent `claude` per session), hooks/MCP permission relay, and channel management.

## Project

Type: other (Tauri 2 / Rust + vanilla JS webview)
Deploy: GitHub Releases (NSIS / DMG / DEB + AppImage via CI)

## Structure

`src-tauri/src/` Rust backend, `src/` frontend SPA, `src-tauri/tauri.conf.json` Tauri config

## Commands

- Dev: `cargo tauri dev` (runs from anywhere in the repo; the Tauri CLI auto-locates `src-tauri/tauri.conf.json`)
- Verify: `cargo build --manifest-path src-tauri/Cargo.toml`

## Rules

- Keep `README.md` in sync when auth flow, tray behavior, scraping approach, or project structure changes. README is user-facing; CLAUDE.md is developer rules only.
- Chat hub is subscription-only. `check_metered_billing` in `chat/billing.rs` refuses to spawn if `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, Bedrock, or Vertex env vars are set.
- No auto-restart on channel exit - would register a fresh bridge with Claude desktop each time, creating duplicate entries in the Code sidebar. Spawn once, stay dead until manual Restart.
- Linux: chat hub works but channel automation (Plan C) unavailable (`SpawnError::NonWindows`).
- New IPC command requires a matching entry in `src-tauri/capabilities/default.json` or it silently fails.
- When writing something Joe is meant to copy-paste, use a **fenced code block** for commands/code/config (gets syntax highlighting + copy button) or a **blockquote** for prose he'll paste elsewhere (e.g. a message draft). Plain text gets no copy button. Never use a blockquote for technical content - it loses syntax highlighting.
