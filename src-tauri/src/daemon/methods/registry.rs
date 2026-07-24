//! Registry-mutation RPC methods: mark-ended, externalize, set-effort,
//! register-historical, manual takeover, and the list-instances snapshot fetch.

use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use crate::types::EndReason;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

pub fn register_chat_registry(router: &mut Router, state: Arc<DaemonState>) {
    #[derive(serde::Deserialize)]
    struct SessionId { session_id: String }
    #[derive(serde::Deserialize)]
    struct EffortParams { session_id: String, effort: String }
    #[derive(serde::Deserialize)]
    struct HistoricalParams { session_id: String, cwd: String, account_id: String }

    {
        let state = state.clone();
        router.register("mark_session_ended", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: SessionId = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let now = chrono::Utc::now().to_rfc3339();
                state.registry.mark_ended(&p.session_id, EndReason::Manual, &now);
                state.notifier.publish("instances_changed", json!({"instances": state.registry.list()}));
                crate::sessions::persistence::save_snapshot_default(&state.registry);
                Ok(json!({"ok": true}))
            }
        });
    }
    {
        let state = state.clone();
        router.register("externalize_session", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: SessionId = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                state.registry.externalize_session(&p.session_id);
                state.notifier.publish("instances_changed", json!({"instances": state.registry.list()}));
                // Now External: drop it from the Interactive snapshot so a daemon
                // restart doesn't resurrect it as a ghost Interactive entry.
                crate::sessions::persistence::save_snapshot_default(&state.registry);
                Ok(json!({"ok": true}))
            }
        });
    }
    {
        let state = state.clone();
        router.register("set_session_effort", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: EffortParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                state.registry.set_effort(&p.session_id, &p.effort);
                crate::sessions::chat_config::record(&p.session_id, "", &p.effort);
                state.notifier.publish("instances_changed", json!({"instances": state.registry.list()}));
                crate::sessions::persistence::save_snapshot_default(&state.registry);
                Ok(json!({"ok": true}))
            }
        });
    }
    // Persist a chat's auto-accept-permissions toggle. The daemon is the sole
    // writer of chat-config.json, so both the desktop app (forwarding via the
    // daemon client) and the phone (direct remote RPC) funnel through here.
    router.register("set_auto_accept", move |params, _ctx| {
        async move {
            #[derive(serde::Deserialize)]
            struct P { session_id: String, value: bool }
            let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            crate::sessions::chat_config::set_auto_accept(&p.session_id, p.value);
            Ok(json!({"ok": true}))
        }
    });
    // Session ids with auto-accept enabled, so a freshly-launched client seeds
    // its gate. Read-only; mirrors the desktop `list_auto_accept` Tauri command.
    router.register("list_auto_accept", move |_params, _ctx| {
        async move { Ok(json!(crate::sessions::chat_config::list_auto_accept())) }
    });
    {
        let state = state.clone();
        router.register("register_historical", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: HistoricalParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let cwd = std::path::PathBuf::from(&p.cwd);
                let now = chrono::Utc::now().to_rfc3339();
                let (project_id, created_new) = {
                    let mut snap = state.settings.snapshot();
                    crate::settings::upsert_project_for_cwd(&mut snap, &cwd, &now)
                };
                if created_new {
                    state.notifier.publish("project_created", json!({
                        "project_id": project_id, "cwd": p.cwd, "now": now,
                    }));
                }
                state.registry.upsert_interactive(&p.session_id, &cwd, &project_id, &now);
                // A historical session was never associated with an account in
                // this run (the registry entry may be brand new, or a stale one
                // from before account tracking existed) - record the account the
                // user picked in the "Continue this chat" confirmation, same
                // reasoning as chat::takeover::takeover.
                state.registry.set_account(&p.session_id, &p.account_id);
                crate::sessions::chat_config::set_account(&p.session_id, &p.account_id);
                state.notifier.publish("instances_changed", json!({"instances": state.registry.list()}));
                crate::sessions::persistence::save_snapshot_default(&state.registry);
                Ok(json!({"ok": true}))
            }
        });
    }
    {
        let state = state.clone();
        router.register("takeover_manual", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct TakeoverParams { manual_pid: u32, model: String, effort: String, account_id: String }
                let p: TakeoverParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let shim = std::sync::Mutex::new(state.settings.snapshot());
                let sid = crate::chat::takeover::takeover(p.manual_pid, &p.model, &p.effort, &p.account_id, &state.registry, &shim)
                    .map_err(|e| RpcError::internal(e.to_string()))?;
                state.notifier.publish("instances_changed", json!({"instances": state.registry.list()}));
                crate::sessions::persistence::save_snapshot_default(&state.registry);
                Ok(json!({"session_id": sid}))
            }
        });
    }
    // Snapshot fetch so a freshly-connected app can seed its instance cache
    // without waiting for the next instances_changed notification (ai_todo 63).
    {
        let state = state.clone();
        router.register("list_instances", move |_params, _ctx| {
            let state = state.clone();
            async move { Ok(json!(state.registry.list())) }
        });
    }
    // Read-only character list, exposed over the remote-access API so the phone
    // client can render session avatars without a Tauri runtime. `characters::list()`
    // reads the shared on-disk characters dir (process-local cache, shared files),
    // so it works fine from the daemon process. Same serde shape as the
    // `list_characters` Tauri command (frontend `Character[]`).
    {
        router.register("list_characters", move |_params, _ctx| {
            async move { Ok(json!(crate::characters::list())) }
        });
    }
    // Read-only account list, exposed over the remote-access API so the phone's
    // new-chat account picker can list the same accounts as desktop. Without it
    // the picker is empty and "Start session" stays permanently disabled, which
    // is why chats couldn't be started from mobile at all (ai_todo 241).
    // `accounts::load_registry()` reads the shared on-disk accounts.json - the
    // SAME file the daemon already reads to resolve `start_session`'s account_id
    // - so the daemon process serves it fine. Identical serde shape to the
    // `list_accounts` Tauri command (frontend `Account[]`).
    {
        router.register("list_accounts", move |_params, _ctx| {
            async move { Ok(json!(crate::accounts::load_registry())) }
        });
    }
    // Read-only project-groups list, mirroring the `list_project_groups` Tauri
    // command's JSON shape (frontend `ProjectGroup[]`). Reuses the same PURE
    // `build_groups` helper; inputs are sourced daemon-side: `projects` from the
    // in-memory settings cache, `instances` from the registry snapshot (same as
    // `list_instances`), and `token_history` loaded from disk.
    {
        let state = state.clone();
        router.register("list_project_groups", move |_params, _ctx| {
            let state = state.clone();
            async move {
                let projects = state.settings.snapshot().projects;
                let instances = state.registry.list();
                let now_ms = chrono::Utc::now().timestamp_millis();
                let groups = tokio::task::spawn_blocking(move || {
                    let token_history = match crate::settings::paths::token_history_file() {
                        Ok(p) => crate::tokens::load_history(&p),
                        Err(_) => Vec::new(),
                    };
                    let mut groups = crate::ipc::project_groups::groups_test_helpers::build_groups(
                        &projects, &token_history, &instances, now_ms,
                    );
                    for g in &mut groups {
                        g.path_exists = std::path::Path::new(&g.path).exists();
                    }
                    groups
                })
                .await
                .map_err(|e| RpcError::internal(format!("join: {e}")))?;
                Ok(json!(groups))
            }
        });
    }
    // Paginated transcript reader exposed over the remote-access API so that the
    // phone/browser client can load past conversation history without a Tauri
    // runtime. Reuses the same JSONL logic as the desktop `load_history_page`
    // Tauri command; no parsing is duplicated.
    router.register("load_history_page", move |params, _ctx| {
        async move {
            #[derive(serde::Deserialize)]
            struct HistoryPageParams {
                session_id: String,
                cwd: Option<String>,
                before_seq: Option<u64>,
                message_limit: u32,
            }
            let p: HistoryPageParams = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            // Validate the session id (reuse the same check as the IPC layer to
            // reject path-traversal attempts before any filesystem access).
            crate::ipc::chat::attachments::validate_session_id(&p.session_id)
                .map_err(|e| RpcError::invalid_params(e))?;
            let limit = p.message_limit.clamp(1, 500);
            // Filesystem + JSONL parsing is synchronous IO; run on blocking pool.
            tokio::task::spawn_blocking(move || {
                let path = crate::chat::history::locate_transcript(
                    &p.session_id,
                    p.cwd.as_deref(),
                )?;
                crate::chat::history::read_page(&path, p.before_seq, limit)
            })
            .await
            .map_err(|e| RpcError::internal(format!("join: {e}")))?
            .map(|page| serde_json::to_value(page).unwrap_or(serde_json::Value::Null))
            .map_err(|e| RpcError::internal(e))
        }
    });
    // Read-only character/project asset + metadata methods exposed over the
    // remote-access API so the phone client renders avatars/icons/whitelists
    // without a Tauri runtime. Each mirrors the same-named Tauri command's JSON
    // shape and sources its inputs daemon-side (shared on-disk character files,
    // the settings snapshot, ~/.claude/projects mtimes). No Tauri AppState used.

    // Mirrors `character_asset_url` (params: character_id, file) -> Option<String>
    // data URL. Pure: characters::get + assets::file_data_url_at on shared files.
    router.register("character_asset_url", move |params, _ctx| {
        async move {
            #[derive(serde::Deserialize)]
            struct P { character_id: String, file: String }
            let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            let url = crate::characters::get(&p.character_id)
                .and_then(|c| crate::characters::assets::file_data_url_at(&c.asset_path(&p.file)));
            Ok(json!(url))
        }
    });
    // Mirrors `read_attachment` (params: path) -> { mime, base64 }. Lets the
    // phone render pasted chat-image attachments. The underlying fn canonicalizes
    // the path and rejects anything outside <app-data>/chat-attachments/, so this
    // is NOT an arbitrary-file-read primitive despite taking a path. (Distinct
    // from `read_image_file`, deliberately NOT exposed: it reads arbitrary paths.)
    router.register("read_attachment", move |params, _ctx| {
        async move {
            #[derive(serde::Deserialize)]
            struct P { path: String }
            let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            let data = crate::ipc::chat::attachments::read_attachment(p.path)
                .await
                .map_err(RpcError::internal)?;
            Ok(json!(data))
        }
    });
    // Mirrors `paste_attachment` (params: session_id, base64_data, mime) -> path
    // string. Lets the phone PWA's composer paperclip upload an image/file: the
    // bytes are written into <app-data>/chat-attachments/<session>/ on the PC and
    // the returned path becomes a <file:...> mention claude reads via its Read
    // tool. write_attachment validates the session_id (rejects path traversal),
    // so this is not an arbitrary-write primitive despite taking a session id.
    router.register("paste_attachment", move |params, _ctx| {
        async move {
            #[derive(serde::Deserialize)]
            struct P { session_id: String, base64_data: String, mime: String }
            let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            let root = crate::settings::paths::data_dir()
                .map_err(|e| RpcError::internal(e.to_string()))?;
            let path = crate::ipc::chat::attachments::write_attachment(
                &root, &p.session_id, &p.base64_data, &p.mime,
            )
            .map_err(RpcError::internal)?;
            Ok(json!(path.to_string_lossy().to_string()))
        }
    });
    // Mirrors `resolve_whitelist_characters` (params: project_id) -> Vec<Character>.
    // Reads the project's whitelist + default whitelist from the settings
    // snapshot, then whitelist::resolve over characters::list().
    {
        let state = state.clone();
        router.register("resolve_whitelist_characters", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P { project_id: String }
                let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let s = state.settings.snapshot();
                let proj_wl = s
                    .projects
                    .iter()
                    .find(|pc| pc.id == p.project_id)
                    .map(|pc| pc.whitelist.clone())
                    .unwrap_or(crate::types::CharacterWhitelist::Default);
                let default_wl = s.default_character_whitelist.clone();
                let all = crate::characters::list();
                let resolved_ids = crate::characters::whitelist::resolve(&proj_wl, &default_wl, &all);
                let resolved: Vec<_> = resolved_ids
                    .iter()
                    .filter_map(|id| crate::characters::get(id))
                    .collect();
                Ok(json!(resolved))
            }
        });
    }
    // Mirrors `list_projects` -> Vec<ProjectConfig>. The Tauri command returns
    // `settings.projects.clone()`; the daemon reads the same from its snapshot.
    {
        let state = state.clone();
        router.register("list_projects", move |_params, _ctx| {
            let state = state.clone();
            async move { Ok(json!(state.settings.snapshot().projects)) }
        });
    }
    // Mirrors `list_session_characters` -> { session_id: character_id }. The
    // Tauri command prunes dead sessions before returning; the daemon skips the
    // prune (a read-only display fetch) and returns the full snapshot map. Stale
    // ids are harmless: the frontend only looks up live session ids. Without this
    // the phone sidebar + chat header show the "?" placeholder for every session
    // because the per-session character map never loads (missing avatars).
    {
        let state = state.clone();
        router.register("list_session_characters", move |_params, _ctx| {
            let state = state.clone();
            async move { Ok(json!(state.settings.snapshot().session_characters)) }
        });
    }
    // Mirrors the ASSIGNMENT half of `ensure_session_character` (the Tauri
    // command in ipc/characters.rs), which previously existed ONLY on the app
    // process. HttpTransport had no case for it and the frontend's `.catch(()
    // => null)` swallowed the resulting RemoteUnavailableError, so a
    // remote-created session never got a character (silent no-op). Mutates the
    // daemon's own settings cache immediately for an instant read (mirrors
    // `upsert_project_for_cwd`'s pattern), then - on a FRESH pick only -
    // publishes a notification so a connected app process persists the same
    // assignment to settings.json (see daemon_link.rs's "project_created"
    // handler for the app-side counterpart of this pattern).
    {
        let state = state.clone();
        router.register("ensure_session_character", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P { session_id: String }
                let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;

                let instances = state.registry.list();
                let live_ids: HashSet<String> = instances
                    .iter()
                    .filter(|i| i.end_reason.is_none())
                    .map(|i| i.session_id.clone())
                    .collect();
                let Some(project_id) = instances
                    .iter()
                    .find(|i| i.session_id == p.session_id)
                    .map(|i| i.project_id.clone())
                else {
                    return Ok(json!(null));
                };

                let all = crate::characters::list();
                let (pick, is_new) = state.settings.ensure_session_character(
                    &p.session_id, &project_id, &all, &live_ids,
                );
                if is_new {
                    if let Some(ref character_id) = pick {
                        state.notifier.publish("session_character_assigned", json!({
                            "session_id": p.session_id, "character_id": character_id,
                        }));
                    }
                }
                Ok(json!(pick))
            }
        });
    }
    // Mirrors `project_last_activity_at` (params: cwd) -> i64. PURE fs read of
    // the max *.jsonl mtime under ~/.claude/projects/<encoded-cwd>/.
    router.register("project_last_activity_at", move |params, _ctx| {
        async move {
            #[derive(serde::Deserialize)]
            struct P { cwd: String }
            let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            let secs = tokio::task::spawn_blocking(move || {
                crate::ipc::project_groups::latest_jsonl_mtime_in_projects_dir(
                    std::path::Path::new(&p.cwd),
                )
            })
            .await
            .map_err(|e| RpcError::internal(format!("join: {e}")))?;
            Ok(json!(secs))
        }
    });
    // Mirrors `get_project_tech` (params: root) -> Option<String>. PURE
    // file-existence checks for stack marker files.
    router.register("get_project_tech", move |params, _ctx| {
        async move {
            #[derive(serde::Deserialize)]
            struct P { root: String }
            let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            Ok(json!(crate::ipc::project_icons::get_project_tech(p.root)))
        }
    });
    // Mirrors `get_project_icon` (params: root) -> Option<AttachmentData>. PURE
    // fs read of the first matching icon candidate, inlined as {mime, base64}.
    router.register("get_project_icon", move |params, _ctx| {
        async move {
            #[derive(serde::Deserialize)]
            struct P { root: String }
            let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            Ok(json!(crate::ipc::project_icons::get_project_icon(p.root).await))
        }
    });
    // Mirrors the `list_slash_commands` Tauri command (params: project_dir) ->
    // Vec<SlashEntry>. Read-only filesystem scan of ~/.claude/{commands,skills,
    // plugins} + the project's .claude dir - the daemon runs on the same PC and
    // can read the same disk as the desktop app, so `scan_all` works unchanged.
    // Without this the phone/browser `/` autocomplete popup is always empty
    // (HttpTransport had no case for this command).
    router.register("list_slash_commands", move |params, _ctx| {
        async move {
            #[derive(serde::Deserialize, Default)]
            struct P { project_dir: Option<String> }
            let p: P = serde_json::from_value(params.unwrap_or(Value::Null)).unwrap_or_default();
            let project = p.project_dir.map(std::path::PathBuf::from);
            let entries = tokio::task::spawn_blocking(move || {
                crate::slash::enumerate::scan_all(project.as_deref())
            })
            .await
            .map_err(|e| RpcError::internal(format!("join: {e}")))?;
            Ok(json!(entries))
        }
    });
    // ── Usage + token history (homescreen / stats on the phone) ───────────────
    // All three read the SAME shared `companion.db` the desktop app reads, via
    // the daemon's own connection (`state.db`). They mirror the Tauri commands
    // `get_history` / `get_token_history` / `get_active_sessions` so the remote
    // homescreen, statistics, and projects views populate without a Tauri
    // runtime. The daemon is the writer of these records, so the data is always
    // present; `poll_now` (a CDP scrape) stays app-process-only by design.

    // Mirrors `get_history` (params: { limit }) -> Vec<UsageSnapshot>. Snapshots
    // come back ascending by timestamp; `limit` keeps the newest N (trim front).
    {
        let state = state.clone();
        router.register("get_history", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize, Default)]
                struct P { limit: Option<u32> }
                let p: P = serde_json::from_value(params.unwrap_or(Value::Null)).unwrap_or_default();
                let Some(db) = state.db.clone() else { return Ok(json!([])) };
                let snaps = tokio::task::spawn_blocking(move || {
                    let mgr = db.lock().unwrap_or_else(|e| e.into_inner());
                    let mut all = crate::storage::usage_store::get_all_snapshots(mgr.conn())
                        .unwrap_or_default();
                    if let Some(n) = p.limit {
                        let start = all.len().saturating_sub(n as usize);
                        all = all.split_off(start);
                    }
                    all
                })
                .await
                .map_err(|e| RpcError::internal(format!("join: {e}")))?;
                Ok(json!(snaps))
            }
        });
    }
    // Mirrors `get_token_history` -> Vec<TokenRecord>, filtering empty session
    // ids to match the desktop's `load_history_from_db` behaviour.
    {
        let state = state.clone();
        router.register("get_token_history", move |_params, _ctx| {
            let state = state.clone();
            async move {
                let Some(db) = state.db.clone() else { return Ok(json!([])) };
                let records = tokio::task::spawn_blocking(move || {
                    let mgr = db.lock().unwrap_or_else(|e| e.into_inner());
                    crate::storage::token_store::get_token_records(mgr.conn(), 0)
                        .unwrap_or_default()
                        .into_iter()
                        .filter(|r| !r.session_id.is_empty())
                        .collect::<Vec<_>>()
                })
                .await
                .map_err(|e| RpcError::internal(format!("join: {e}")))?;
                Ok(json!(records))
            }
        });
    }
    // Mirrors `get_active_sessions` -> Vec<TokenRecord>: the in-flight usage
    // derived from the same history (live token merge on the homescreen/stats).
    {
        let state = state.clone();
        router.register("get_active_sessions", move |_params, _ctx| {
            let state = state.clone();
            async move {
                let Some(db) = state.db.clone() else { return Ok(json!([])) };
                let active = tokio::task::spawn_blocking(move || {
                    let mgr = db.lock().unwrap_or_else(|e| e.into_inner());
                    let history = crate::storage::token_store::get_token_records(mgr.conn(), 0)
                        .unwrap_or_default()
                        .into_iter()
                        .filter(|r| !r.session_id.is_empty())
                        .collect::<Vec<_>>();
                    crate::tokens::active_sessions_from_history(&history)
                })
                .await
                .map_err(|e| RpcError::internal(format!("join: {e}")))?;
                Ok(json!(active))
            }
        });
    }
    // Mirrors `get_usage_map` (the desktop Tauri command in `ipc/usage.rs`) ->
    // HashMap<account_id, UsageSnapshot>. Desktop reads this straight out of
    // `AppState.current_usage_by_account`, an in-memory cache the daemon (a
    // separate process) cannot see; instead this reduces the SAME `companion.db`
    // `get_history` already reads down to the newest row per `account_id`.
    // `get_all_snapshots` returns rows ascending by timestamp, so a plain
    // insert-per-row walk naturally leaves the latest snapshot per account in
    // the map (later rows overwrite earlier ones for the same key). Snapshots
    // with no `account_id` (legacy single-cookie poll) are skipped, matching
    // desktop's map which is keyed by `Account.id` only.
    {
        let state = state.clone();
        router.register("get_usage_map", move |_params, _ctx| {
            let state = state.clone();
            async move {
                let Some(db) = state.db.clone() else { return Ok(json!({})) };
                let map = tokio::task::spawn_blocking(move || {
                    let mgr = db.lock().unwrap_or_else(|e| e.into_inner());
                    let all = crate::storage::usage_store::get_all_snapshots(mgr.conn())
                        .unwrap_or_default();
                    let mut map: HashMap<String, crate::types::UsageSnapshot> = HashMap::new();
                    for snap in all {
                        if let Some(id) = snap.account_id.clone() {
                            map.insert(id, snap);
                        }
                    }
                    map
                })
                .await
                .map_err(|e| RpcError::internal(format!("join: {e}")))?;
                Ok(json!(map))
            }
        });
    }
    // Mirrors `get_auth_state_map` (the desktop Tauri command in `ipc/usage.rs`)
    // -> HashMap<account_id, AuthState>. Desktop reads this from
    // `AppState.auth_state_by_account`, which is populated ONLY by the app
    // process's poll loop (`scheduler::do_poll_accounts`) and is never
    // persisted to `companion.db`, `settings.json`, or any other file the
    // daemon can read - so an exact mirror is not possible cross-process.
    // Best available proxy on shared disk: whether each registered account's
    // session-key cookie file (`settings::paths::account_session_file`, the
    // SAME file `do_poll_accounts` itself reads via `auth::session::load`)
    // exists and is non-empty. No file -> `NeedsLogin` (this exactly mirrors
    // `do_poll_accounts`'s own "no session" failure branch). A present file is
    // reported `LoggedIn`; the daemon cannot detect an already-expired-but-
    // present cookie without itself performing a live network poll against
    // claude.ai, which is out of scope for this read-only mirror (every other
    // daemon RPC in this file is a pure disk/db read, never a live external
    // call triggered by a read). `InProgress` is never returned - the daemon
    // doesn't drive the CDP login flow.
    router.register("get_auth_state_map", move |_params, _ctx| {
        async move {
            let accounts = crate::accounts::load_registry();
            let map = tokio::task::spawn_blocking(move || {
                let mut map: HashMap<String, crate::types::AuthState> = HashMap::new();
                for account in accounts {
                    let Ok(path) = crate::settings::paths::account_session_file(&account.id)
                    else {
                        continue;
                    };
                    let auth_state = if crate::auth::session::load(&path).is_some() {
                        crate::types::AuthState::LoggedIn
                    } else {
                        crate::types::AuthState::NeedsLogin
                    };
                    map.insert(account.id, auth_state);
                }
                map
            })
            .await
            .map_err(|e| RpcError::internal(format!("join: {e}")))?;
            Ok(json!(map))
        }
    });
    // ── HTML preview window (ai_todo 138) ──────────────────────────────────
    // `list_previews`/`get_preview` are read-only mirrors of `daemon::preview`'s
    // store, exposed over both the daemon's own pipe RPC (desktop IPC proxy)
    // and the remote-access API (SAFE_METHODS in remote_handlers.rs) so the
    // phone can read the same timeline later with no store rewrite.
    //
    // `push_preview` is registered on the pipe Router ONLY (the desktop
    // `push_preview` command's proxy target) and is deliberately EXCLUDED from
    // SAFE_METHODS: the phone/remote write path is a separate reviewed
    // decision. Terminal Claude and the in-app chat AI both push via the
    // UNAUTHENTICATED `/hooks/preview` hook-server endpoint instead (see
    // `hooks_server/preview.rs`), which shares `preview::push_and_notify` with
    // this handler so both write paths stay in sync.
    {
        let state = state.clone();
        router.register("push_preview", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P {
                    title: String,
                    #[serde(default)]
                    slug: Option<String>,
                    html: String,
                    #[serde(default)]
                    source: Option<String>,
                    #[serde(default)]
                    session_id: Option<String>,
                }
                let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let source = p.source.filter(|s| !s.is_empty()).unwrap_or_else(|| "terminal".to_string());
                let id = crate::daemon::preview::push_and_notify(&state, p.title, p.slug, p.html, source, p.session_id)
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                Ok(json!({ "id": id }))
            }
        });
    }
    // Mirrors the desktop `list_previews` command -> Vec<PreviewMeta>, newest
    // (most-recently-pushed/replaced) first. No html - see PreviewMeta.
    router.register("list_previews", move |_params, _ctx| {
        async move { Ok(json!(crate::daemon::preview::list())) }
    });
    // Mirrors the desktop `get_preview` command (params: id) -> PreviewSnapshot
    // (html included), for the iframe render.
    router.register("get_preview", move |params, _ctx| {
        async move {
            #[derive(serde::Deserialize)]
            struct P { id: String }
            let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            match crate::daemon::preview::get(&p.id) {
                Some(snap) => Ok(json!(snap)),
                None => Err(RpcError::internal(format!("no such preview: {}", p.id))),
            }
        }
    });
}
