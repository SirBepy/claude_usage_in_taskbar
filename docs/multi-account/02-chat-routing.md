# Milestone 02 - Per-account chat routing (CLAUDE_CONFIG_DIR injection)

Depends on: 01 (accounts + profile dirs exist). See `00-overview.md`.

## Goal
Make each chat session run as a chosen account by setting `CLAUDE_CONFIG_DIR` to that account's
profile dir at spawn time. App chats NEVER spawn against `~/.claude`; the subscription-only
billing gate holds per child.

## Context (current single-account reality)
- Three `claude` spawn sites, ALL set zero env (child inherits the daemon's ambient env, resolving
  `~/.claude`):
  - `daemon/lifecycle.rs:94-121` (`spawn_session`) - `Command::new("claude")`, `current_dir` at
    `:111`, `CREATE_NO_WINDOW`, no `.env`.
  - `channels/spawn.rs:59-158` (`spawn_child`) - Windows `CreateProcessW` with `lpEnvironment` None
    at `:93`; macOS `Command::new("claude")` at `:124-134`.
  - `news/summarizer.rs:60` - background news summarization.
- `StartSessionParams` (`daemon/lifecycle.rs:32-43`) is the params struct to extend.
- Billing gate `check_metered_billing` (`chat/billing.rs:30-37`) refuses if `ANTHROPIC_API_KEY` /
  `ANTHROPIC_AUTH_TOKEN` / Bedrock / Vertex are set; called at `lifecycle.rs:74-76` reading the
  DAEMON's own env (`std::env::var`), not the child's.
- `~/.claude` is hardcoded via `dirs::home_dir()` in ~10 readers: `hooks/session_files.rs:48,102`,
  `hooks/installer.rs:94`, `daemon/jsonl_tail.rs:22`, `tokens/walker.rs:6`, `slash/watcher.rs:10`,
  `slash/enumerate.rs:15`, `ipc/project_groups.rs:161`, `ipc/models.rs:27,66`.

## Approach
1. **Inject `CLAUDE_CONFIG_DIR` at every spawn site.** `.env("CLAUDE_CONFIG_DIR",
   account.config_dir)` in `lifecycle.rs`; build an `lpEnvironment` block (parent env + override)
   for the Windows `CreateProcessW` branch and `cmd.env(...)` on macOS in `channels/spawn.rs`;
   `news/summarizer.rs` uses the default account (registry empty = skip summarization);
   channels (`channels/spawn.rs`) use the default account for now (per-channel binding is a later
   nice-to-have). Defensively unset `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` **and
   `CLAUDE_CODE_OAUTH_TOKEN`** on the child - the OAuth token env var outranks
   `.credentials.json`, so a stray ambient token would silently rebind the child to a different
   account (the OLD plan whitelisted this var; the new design must scrub it).
   There is no no-override spawn path: a chat REQUIRES a registry account. If the registry is
   empty, new-chat routes to the add-account wizard instead of spawning.
2. **Thread `account_id`.** Add it to `StartSessionParams` (`lifecycle.rs:32-43`) and up through
   the IPC that starts a session; resolve `config_dir` from the account store (01) at spawn.
   Persist the session->account attribution (session registry `Instance` in `types/project.rs`,
   and/or `chat-config.json`).
3. **Billing gate per child.** Run `check_metered_billing` against the ENV BEING INJECTED (parent
   env + overrides - the unsets from step 1), not the daemon's ambient env alone.
3b. **Pre-spawn drift guard.** Before spawning, read the profile's `oauthAccount` (cheap local
   file read) and compare `organizationUuid`/email against the registry record. Mismatch (someone
   ran `/login` inside that dir since onboarding) = refuse to spawn, surface "account X is now
   logged in as Y - re-auth or re-verify" instead of silently billing the wrong account.
4. **The `~/.claude` readers stay valid - because of the junctions.** Profile dirs junction
   `projects/`, `todos/`, `sessions/` back to `~/.claude` (01), so transcripts, session files,
   and todo state written by an app-spawned child land in the one pool the daemon already reads.
   Audit each reader to confirm; document the audit result inline so a future reader does not
   re-investigate. Two that need attention:
   - `ipc/models.rs:27,66` reads `~/.claude/.credentials.json` for the model-list probe. Make it
     take the account (probe that profile's credentials), defaulting to the default account.
   - `hooks/installer.rs:94` writes the SessionStart/SessionEnd hook into `~/.claude/settings.json`
     - which every profile sees via the settings.json symlink, so per-profile hook install is
     free. Verify, don't re-install per profile.
5. **Attribution of incoming sessions.** App-spawned sessions: the daemon knows the account at
   spawn (step 2). Terminal sessions (hook-reported, not app-spawned): attribute to the observed
   terminal identity (01's `terminal_identity()`), displayed as such in the Sessions screen -
   they are monitored, not owned.

## Files
- `src-tauri/src/daemon/lifecycle.rs` (env inject + `StartSessionParams.account_id`).
- `src-tauri/src/channels/spawn.rs` (env inject both OS branches).
- `src-tauri/src/news/summarizer.rs` (default-account env).
- `src-tauri/src/chat/billing.rs` (gate against injected env).
- `src-tauri/src/sessions/registry.rs`, `types/project.rs` (session->account).
- `src-tauri/src/ipc/models.rs` (per-account creds probe).
- IPC that starts sessions (+ `export_types.rs` if params change shape).

## Acceptance
- A Work chat and a Personal chat run AT THE SAME TIME, each spawned with its own
  `CLAUDE_CONFIG_DIR`, each billed to its own subscription, no credential-file interaction.
- No spawn path exists that reaches `~/.claude` credentials; with an empty registry, new-chat
  opens the wizard instead.
- Killing/refreshing one chat does not affect the other's auth.
- Billing gate still blocks a session if a forbidden metered env var survives the unsets;
  otherwise passes per account.
- Transcripts land in the shared pool via the junction and are attributed to the right account via
  the session->account map (verify against the token walker output per session).
- Terminal sessions still appear in the Sessions screen, labeled with the terminal identity.
