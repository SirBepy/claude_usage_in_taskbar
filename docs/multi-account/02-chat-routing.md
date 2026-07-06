# Milestone 02 - Per-account chat routing (spawn injection)

Depends on: 01 (accounts + tokens exist). See `00-overview.md`.

## Goal
Make each chat session run as a chosen account by injecting that account's
`CLAUDE_CODE_OAUTH_TOKEN` at spawn time, from ONE shared `~/.claude`, with the subscription-only
billing gate holding per account.

## Context (current single-account reality)
- Two `claude` spawn sites, BOTH set zero env (child inherits the daemon's ambient env, resolving
  whatever `~/.claude` the OS user has):
  - `daemon/lifecycle.rs:94-121` (`spawn_session`) - `Command::new("claude")`, `current_dir` at
    `:111`, `CREATE_NO_WINDOW`, no `.env`.
  - `channels/spawn.rs:59-158` (`spawn_child`) - Windows `CreateProcessW` with `lpEnvironment` None
    at `:93`; macOS `Command::new("claude")` at `:124-134`.
- `StartSessionParams` (`daemon/lifecycle.rs:32-43`) is the params struct to extend.
- Billing gate `check_metered_billing` (`chat/billing.rs:30-37`) refuses if `ANTHROPIC_API_KEY` /
  `ANTHROPIC_AUTH_TOKEN` / Bedrock / Vertex are set; called at `lifecycle.rs:74-76` reading the
  DAEMON's own env (`std::env::var`), not the child's.
- `~/.claude` is hardcoded via `dirs::home_dir()` in ~10 readers: `hooks/session_files.rs:48,102`,
  `hooks/installer.rs:94`, `daemon/jsonl_tail.rs:22`, `tokens/walker.rs:6`, `slash/watcher.rs:10`,
  `slash/enumerate.rs:15`, `ipc/project_groups.rs:161`, `ipc/models.rs:27,66`.

## Approach
1. **Inject the token at both spawn sites.** Add `.env("CLAUDE_CODE_OAUTH_TOKEN", token)` next to
   `current_dir` in `lifecycle.rs:111`; set the `CreateProcessW` `lpEnvironment` (currently None)
   and the macOS `cmd.env(...)` in `channels/spawn.rs`. Also defensively unset `ANTHROPIC_API_KEY`
   on the child so a stray key can't outrank the token (precedence: API key > OAuth token).
   Account #default uses no token override (falls back to `.credentials.json`) OR its own token;
   pick one and be consistent (recommend: default account also uses an explicit token for
   uniformity).
2. **Thread `account_id`.** Add it to `StartSessionParams` (`lifecycle.rs:32-43`) and up through
   the IPC that starts a session; resolve the token from the account store (01) at spawn.
3. **Billing gate per account.** Re-run `check_metered_billing` against the ENV BEING INJECTED
   (not just the daemon's own env). If the account is a real subscription token, the gate is
   orthogonal and passes; the only failure is a stray forbidden env var, which we unset per child.
4. **Session -> account attribution.** Persist which account a session belongs to (session
   registry `Instance` in `types/project.rs`, and/or `chat-config.json`). This is how the app
   attributes transcripts/tokens per account WITHOUT splitting the filesystem.
5. **Audit the ~10 `~/.claude` readers.** With one shared config dir, they read the correct (only)
   dir and DO NOT need per-account variants. Confirm each is account-agnostic. Exception to note:
   the `ipc/models.rs` creds probe reads `.credentials.json`; with env tokens it should probe the
   per-account token instead (or accept that model-availability is account-independent for now).
   Document the audit result inline so a future reader does not re-investigate.

## Files
- `src-tauri/src/daemon/lifecycle.rs` (env inject + `StartSessionParams.account_id`).
- `src-tauri/src/channels/spawn.rs` (env inject both OS branches).
- `src-tauri/src/chat/billing.rs` (gate against injected env).
- `src-tauri/src/sessions/registry.rs`, `types/project.rs` (session->account).
- IPC that starts sessions (+ `export_types.rs` if params change shape).

## Acceptance
- A Work chat and a Personal chat run AT THE SAME TIME from one `~/.claude`, each authed to its own
  account, with no credential-file clobbering and no cross-login.
- Killing/refreshing one does not affect the other's auth.
- Billing gate still blocks a session if a forbidden metered env var is present; otherwise passes
  per account.
- Transcripts/token counts are attributed to the right account via the session->account map
  (verify against the token walker output per session).
