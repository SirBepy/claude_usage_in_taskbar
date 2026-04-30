use crate::state::AppState;
use crate::types::{ProjectConfig, ProjectsSortBy};
use crate::settings::{self, paths};
use tauri::{AppHandle, Emitter, State};

pub mod groups_test_helpers {
    use crate::types::{Avatar, Instance, ProjectConfig, ProjectGroup};
    use crate::settings::store::project_key;
    use std::collections::HashMap;
    use std::path::Path;

    /// Build the dashboard's grouped project list from raw inputs.
    /// Pure: no IO, no global state. The Tauri command wraps this with
    /// `state.settings`, token-history file load, and the live registry.
    pub fn build_groups(
        projects: &[ProjectConfig],
        token_history: &[crate::tokens::TokenRecord],
        instances: &[Instance],
        now_ms: i64,
    ) -> Vec<ProjectGroup> {
        let mut by_key: HashMap<String, ProjectGroup> = HashMap::new();

        // 1. Seed from token history.
        for rec in token_history {
            let Some(cwd) = rec.cwd.as_deref() else { continue };
            let key = project_key(Path::new(cwd));
            let entry = by_key.entry(key.clone()).or_insert_with(|| empty_group(&key, cwd));
            entry.tokens_7d = entry.tokens_7d.saturating_add(rec.input_tokens + rec.output_tokens);
            update_last_active(&mut entry.last_active_at, &rec.last_active_at);
            update_last_active(&mut entry.last_active_at, &rec.started_at);
        }

        // 2. Layer settings.projects on top.
        for p in projects {
            let key = project_key(&p.path);
            let entry = by_key
                .entry(key.clone())
                .or_insert_with(|| empty_group(&key, &p.path.to_string_lossy()));
            entry.id = Some(p.id.clone());
            entry.name = p.name.clone();
            entry.avatar = p.avatar.clone();
            entry.automation_enabled = p.automation.as_ref().map(|a| a.enabled).unwrap_or(false);
            if let Some(la) = p.last_active_at.as_deref() {
                update_last_active(&mut entry.last_active_at, la);
            }
            entry.path = p.path.to_string_lossy().into_owned();
        }

        // 3. Layer live instances on top.
        let now_iso = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(now_ms)
            .unwrap_or_else(chrono::Utc::now)
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        for inst in instances {
            if inst.end_reason.is_some() { continue }
            let key = project_key(&inst.cwd);
            let entry = by_key
                .entry(key.clone())
                .or_insert_with(|| empty_group(&key, &inst.cwd.to_string_lossy()));
            entry.live = entry.live.saturating_add(1);
            entry.any_remote = entry.any_remote || inst.is_remote;
            entry.any_automated = entry.any_automated
                || matches!(inst.kind, crate::types::InstanceKind::Automated);
            update_last_active(&mut entry.last_active_at, &now_iso);
        }

        // 4. Disambiguate: when basenames collide, set parent_segment.
        let mut basename_counts: HashMap<String, u32> = HashMap::new();
        for g in by_key.values() {
            *basename_counts.entry(g.name.clone()).or_insert(0) += 1;
        }
        let mut out: Vec<ProjectGroup> = by_key.into_values().collect();
        for g in out.iter_mut() {
            if basename_counts.get(&g.name).copied().unwrap_or(0) > 1 {
                g.parent_segment = parent_segment_of(&g.path);
            }
        }
        out
    }

    fn empty_group(_key: &str, raw_path: &str) -> ProjectGroup {
        let basename = Path::new(raw_path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(raw_path)
            .to_string();
        ProjectGroup {
            id: None,
            path: raw_path.to_string(),
            name: basename,
            parent_segment: None,
            avatar: Avatar::None,
            automation_enabled: false,
            tokens_7d: 0,
            live: 0,
            any_remote: false,
            any_automated: false,
            last_active_at: None,
        }
    }

    fn update_last_active(slot: &mut Option<String>, candidate: &str) {
        if candidate.is_empty() { return }
        match slot.as_deref() {
            None => *slot = Some(candidate.to_string()),
            Some(cur) if candidate > cur => *slot = Some(candidate.to_string()),
            _ => {}
        }
    }

    fn parent_segment_of(raw_path: &str) -> Option<String> {
        Path::new(raw_path)
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|s| s.to_str())
            .map(|s| s.to_string())
    }
}

/// Pure helpers extracted from the Tauri command wrappers so they can be
/// unit-tested without standing up a full app handle.
pub mod projects_test_helpers {
    use crate::types::{ProjectConfig, ProjectsSortBy, Settings};

    pub fn list_from(s: &Settings) -> Vec<ProjectConfig> { s.projects.clone() }

    pub fn get_from(s: &Settings, id: &str) -> Option<ProjectConfig> {
        s.projects.iter().find(|p| p.id == id).cloned()
    }

    /// Applies a partial JSON patch in-place. Unknown keys are ignored.
    /// Returns `true` if the project existed.
    pub enum UpdateErr {
        NotFound,
        InvalidPatch(String),
    }

    pub fn update_in(s: &mut Settings, id: &str, patch: serde_json::Value)
        -> Result<(), UpdateErr>
    {
        let Some(p) = s.projects.iter_mut().find(|p| p.id == id) else {
            return Err(UpdateErr::NotFound);
        };
        // Round-trip the project through JSON, apply the patch, deserialize
        // back. This gives us a free partial update without per-field code.
        let mut obj = serde_json::to_value(&*p).ok().and_then(|v| v.as_object().cloned()).unwrap_or_default();
        if let Some(patch_obj) = patch.as_object() {
            for (k, v) in patch_obj {
                obj.insert(k.clone(), v.clone());
            }
        }
        match serde_json::from_value::<ProjectConfig>(serde_json::Value::Object(obj)) {
            Ok(updated) => { *p = updated; Ok(()) }
            Err(e) => Err(UpdateErr::InvalidPatch(e.to_string())),
        }
    }

    pub fn delete_in(s: &mut Settings, id: &str) -> bool {
        let before = s.projects.len();
        s.projects.retain(|p| p.id != id);
        s.projects.len() < before
    }

    pub fn set_sort_by(s: &mut Settings, sort_by: ProjectsSortBy) {
        s.projects_sort_by = sort_by;
    }
}

pub mod legacy_import_test_helpers {
    use crate::types::{AutomationConfig, ProjectConfig, Settings};

    pub fn import_into(
        settings: &mut Settings,
        legacy_raw: &str,
        now: &str,
    ) -> Option<ProjectConfig> {
        let v: serde_json::Value = serde_json::from_str(legacy_raw).ok()?;
        let vault = v.get("vault_path").and_then(|p| p.as_str())?;
        let (id, _) = crate::settings::upsert_project_for_cwd(
            settings,
            std::path::Path::new(vault),
            now,
        );
        let p = settings.projects.iter_mut().find(|p| p.id == id).unwrap();
        if p.automation.is_none() {
            p.automation = Some(AutomationConfig {
                enabled: true,
                autostart_on_boot: v
                    .get("auto_registered_startup")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true),
                session_name_prefix: None,
                continue_flag: true,
            });
        }
        Some(p.clone())
    }
}

#[tauri::command]
pub fn list_projects(state: State<AppState>) -> Vec<ProjectConfig> {
    projects_test_helpers::list_from(&state.settings.lock().unwrap())
}

#[tauri::command]
pub fn get_project(id: String, state: State<AppState>) -> Option<ProjectConfig> {
    projects_test_helpers::get_from(&state.settings.lock().unwrap(), &id)
}

/// Ensures a `ProjectConfig` exists for the given cwd. If one is already
/// registered (by project key) it is returned as-is; otherwise a fresh
/// entry is created via `upsert_project_for_cwd` and persisted. Exposed for
/// dashboard surfaces like the Project Detail view, which can open on a cwd
/// seen only via token-stats (never hooked) and thus absent from
/// `settings.projects`.
#[tauri::command]
pub fn ensure_project(
    cwd: String,
    state: State<AppState>,
    app: AppHandle,
) -> Result<ProjectConfig, String> {
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let (project, changed, snapshot) = {
        let mut guard = state.settings.lock().unwrap();
        let (id, created) = crate::settings::upsert_project_for_cwd(
            &mut guard,
            std::path::Path::new(&cwd),
            &now,
        );
        let p = guard.projects.iter().find(|p| p.id == id)
            .cloned()
            .ok_or("project upsert produced no entry")?;
        (p, created, guard.clone())
    };
    if changed {
        let settings_path = paths::settings_file().map_err(|e| e.to_string())?;
        settings::save(&settings_path, &snapshot).map_err(|e| e.to_string())?;
        let _ = app.emit("settings-changed", snapshot);
    }
    Ok(project)
}

#[tauri::command]
pub fn update_project(
    id: String,
    patch: serde_json::Value,
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let settings_path = paths::settings_file().map_err(|e| e.to_string())?;
    let mut guard = state.settings.lock().unwrap();
    match projects_test_helpers::update_in(&mut guard, &id, patch) {
        Ok(()) => {}
        Err(projects_test_helpers::UpdateErr::NotFound) => {
            return Err(format!("project_not_found: {id}"));
        }
        Err(projects_test_helpers::UpdateErr::InvalidPatch(msg)) => {
            return Err(format!("invalid_patch: {msg}"));
        }
    }
    settings::save(&settings_path, &guard).map_err(|e| e.to_string())?;
    let snapshot = guard.clone();
    drop(guard);
    let _ = app.emit("settings-changed", snapshot);
    Ok(())
}

#[tauri::command]
pub fn delete_project(
    id: String,
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let settings_path = paths::settings_file().map_err(|e| e.to_string())?;
    let mut guard = state.settings.lock().unwrap();
    if !projects_test_helpers::delete_in(&mut guard, &id) {
        return Err(format!("project_not_found: {id}"));
    }
    settings::save(&settings_path, &guard).map_err(|e| e.to_string())?;
    let snapshot = guard.clone();
    drop(guard);
    let _ = app.emit("settings-changed", snapshot);
    Ok(())
}

#[tauri::command]
pub fn set_projects_sort_by(
    sort_by: ProjectsSortBy,
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let settings_path = paths::settings_file().map_err(|e| e.to_string())?;
    let mut guard = state.settings.lock().unwrap();
    projects_test_helpers::set_sort_by(&mut guard, sort_by);
    settings::save(&settings_path, &guard).map_err(|e| e.to_string())?;
    let snapshot = guard.clone();
    drop(guard);
    let _ = app.emit("settings-changed", snapshot);
    Ok(())
}

/// Preview-only: reads the legacy obsidian_claude_remote config.json and
/// returns what WOULD be imported. Does NOT write settings. Returns None if
/// the user has already handled the prompt (accept or decline) in a prior
/// session, if there is no legacy file on disk, or if it lacks a vault_path.
#[tauri::command]
pub fn import_legacy_obsidian_config(
    state: State<AppState>,
) -> Result<Option<crate::types::ProjectConfig>, String> {
    {
        let guard = state.settings.lock().unwrap();
        if guard.legacy_obsidian_import_handled {
            return Ok(None);
        }
    }
    let Some(appdata) = dirs::config_dir() else { return Ok(None) };
    let config_path = appdata.join("obsidian_claude_remote").join("config.json");
    let raw = match std::fs::read_to_string(&config_path) {
        Ok(s) => s,
        Err(_) => return Ok(None),
    };
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let mut preview = state.settings.lock().unwrap().clone();
    Ok(legacy_import_test_helpers::import_into(&mut preview, &raw, &now))
}

/// Commit the user's choice on the legacy import banner. When `accept` is
/// true, the legacy config is actually imported into settings. Either way,
/// the handled flag is set so the banner never shows again on future loads.
#[tauri::command]
pub fn confirm_legacy_obsidian_import(
    accept: bool,
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let snapshot = {
        let mut guard = state.settings.lock().unwrap();
        if accept {
            if let Some(appdata) = dirs::config_dir() {
                let config_path = appdata.join("obsidian_claude_remote").join("config.json");
                if let Ok(raw) = std::fs::read_to_string(&config_path) {
                    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
                    let _ = legacy_import_test_helpers::import_into(&mut guard, &raw, &now);
                }
            }
        }
        guard.legacy_obsidian_import_handled = true;
        guard.clone()
    };
    let settings_path = paths::settings_file().map_err(|e| e.to_string())?;
    settings::save(&settings_path, &snapshot).map_err(|e| e.to_string())?;
    let _ = app.emit("settings-changed", snapshot);
    Ok(())
}

/// Open a filesystem path in the OS file manager (Explorer on Windows,
/// Finder on macOS, default handler on Linux).
#[tauri::command]
pub fn open_in_explorer(path: String) -> Result<(), String> {
    if path.is_empty() { return Err("empty path".into()) }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("explorer spawn failed: {e}"))
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(&path).spawn()
            .map(|_| ()).map_err(|e| format!("open spawn failed: {e}"))
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open").arg(&path).spawn()
            .map(|_| ()).map_err(|e| format!("xdg-open spawn failed: {e}"))
    }
}

/// Open a folder in VS Code.
#[tauri::command]
pub fn open_in_vscode(path: String) -> Result<(), String> {
    if path.is_empty() { return Err("empty path".into()) }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "code", "-n", &path])
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("code launch failed: {e}"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("code").args(["-n", &path]).spawn()
            .map(|_| ()).map_err(|e| format!("code launch failed: {e}"))
    }
}

/// Bulk existence check for project directories.
#[tauri::command]
pub fn check_paths_exist(paths: Vec<String>) -> std::collections::HashMap<String, bool> {
    paths
        .into_iter()
        .map(|p| {
            let exists = std::path::Path::new(&p).exists();
            (p, exists)
        })
        .collect()
}

// --- Vault detector ---

#[tauri::command]
pub fn detect_obsidian_vaults() -> Vec<std::path::PathBuf> {
    crate::channels::vault_detector::detect().unwrap_or_default()
}

// --- Instances ---

#[tauri::command]
pub fn list_instances(state: State<AppState>) -> Vec<crate::types::Instance> {
    state.instances.list()
}

#[tauri::command]
pub fn list_instances_for_project(
    project_id: String,
    state: State<AppState>,
) -> Vec<crate::types::Instance> {
    state.instances.by_project(&project_id)
}

#[tauri::command]
pub fn phone_link(session_id: String, state: State<AppState>) -> Option<String> {
    let inst = state.instances.get(&session_id)?;
    let bridge = inst.bridge_session_id?;
    Some(format!("https://claude.ai/code/{bridge}"))
}

#[tauri::command]
pub fn instance_token_stats(session_id: String, state: State<AppState>) -> serde_json::Value {
    let empty = serde_json::json!({ "tokens": 0, "turns": 0, "prompts": 0 });
    let Some(inst) = state.instances.get(&session_id) else { return empty };
    let path = match inst.transcript_path.as_ref() {
        Some(p) if p.exists() => p.clone(),
        _ => match crate::tokens::latest_transcript_for_cwd(&inst.cwd) {
            Some(p) => p,
            None => return empty,
        },
    };
    let t = crate::tokens::parse_transcript(&path);
    let total = t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_creation_tokens;
    serde_json::json!({
        "tokens": total,
        "turns": t.turns,
        "prompts": t.user_prompts,
    })
}

// --- Hook registration ---

#[tauri::command]
pub fn get_hook_registration_state(
    state: State<AppState>,
    app: AppHandle,
) -> serde_json::Value {
    // Self-heal: if global settings already contain our hook entries
    // (e.g. app-data was wiped on reinstall but ~/.claude/settings.json
    // survived), flip the local flag so the consent modal stops
    // re-prompting forever.
    let needs_heal = {
        let s = state.settings.lock().unwrap();
        !s.hooks_registered && !s.hook_registration_declined
    };
    if needs_heal && crate::hooks::is_installed_globally() {
        let snapshot = {
            let mut g = state.settings.lock().unwrap();
            g.hooks_registered = true;
            g.hook_install_version = crate::hooks::CURRENT_INSTALL_VERSION;
            g.clone()
        };
        if let Ok(path) = paths::settings_file() {
            let _ = settings::save(&path, &snapshot);
        }
        let _ = app.emit("settings-changed", snapshot);
    }
    let s = state.settings.lock().unwrap();
    serde_json::json!({
        "registered": s.hooks_registered,
        "declined": s.hook_registration_declined,
        "port": s.hook_port,
    })
}

#[tauri::command]
pub fn register_hooks_globally(
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let port = {
        let s = state.settings.lock().unwrap();
        s.hook_port.ok_or_else(|| "hook server not started yet".to_string())?
    };
    crate::hooks::install(crate::hooks::HookConfig { port })
        .map_err(|e| e.to_string())?;
    let snapshot = {
        let mut g = state.settings.lock().unwrap();
        g.hooks_registered = true;
        g.hook_registration_declined = false;
        g.hook_install_version = crate::hooks::CURRENT_INSTALL_VERSION;
        g.clone()
    };
    let path = paths::settings_file().map_err(|e| e.to_string())?;
    settings::save(&path, &snapshot).map_err(|e| e.to_string())?;
    let _ = app.emit("settings-changed", snapshot);
    Ok(())
}

#[tauri::command]
pub fn skip_hook_registration(
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let snapshot = {
        let mut g = state.settings.lock().unwrap();
        g.hook_registration_declined = true;
        g.clone()
    };
    let path = paths::settings_file().map_err(|e| e.to_string())?;
    settings::save(&path, &snapshot).map_err(|e| e.to_string())?;
    let _ = app.emit("settings-changed", snapshot);
    Ok(())
}

#[tauri::command]
pub fn list_project_groups(state: State<AppState>) -> Vec<crate::types::ProjectGroup> {
    let projects = state.settings.lock().unwrap().projects.clone();
    let token_history = match paths::token_history_file() {
        Ok(p) => crate::tokens::load_history(&p),
        Err(_) => Vec::new(),
    };
    let instances = state.instances.list();
    let now_ms = chrono::Utc::now().timestamp_millis();
    groups_test_helpers::build_groups(&projects, &token_history, &instances, now_ms)
}

#[cfg(test)]
mod build_groups_tests {
    use super::groups_test_helpers::build_groups;
    use crate::tokens::TokenRecord;
    use crate::types::{
        AutomationConfig, Avatar, Instance, InstanceKind, ProjectConfig,
    };
    use std::path::PathBuf;

    fn token(cwd: &str, input: u64, output: u64, last: &str) -> TokenRecord {
        TokenRecord {
            session_id: format!("s-{cwd}-{last}"),
            cwd: Some(cwd.to_string()),
            date: "2026-04-29".into(),
            input_tokens: input,
            output_tokens: output,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            turns: 0,
            started_at: last.to_string(),
            last_active_at: last.to_string(),
            recorded_at: last.to_string(),
            live: None,
            merged_subagents: None,
        }
    }

    #[test]
    fn collapses_drive_letter_casing_in_token_history() {
        // Both rows refer to the same nonexistent path under different
        // casing. project_key falls back to normalize_cwd_key (lowercases
        // on Windows/macOS), so they share a key.
        let history = vec![
            token("C:\\Users\\joe\\repo", 10, 5, "2026-04-29T10:00:00Z"),
            token("c:\\Users\\joe\\repo", 20, 7, "2026-04-29T11:00:00Z"),
        ];
        let groups = build_groups(&[], &history, &[], 0);
        // Cross-platform: only collapse when the OS folds case.
        if cfg!(any(windows, target_os = "macos")) {
            assert_eq!(groups.len(), 1, "case variants must collapse");
            assert_eq!(groups[0].tokens_7d, 10 + 5 + 20 + 7);
        } else {
            assert_eq!(groups.len(), 2);
        }
    }

    #[test]
    fn settings_entry_overrides_basename_with_user_name() {
        let history = vec![token("C:\\Users\\joe\\repo", 1, 1, "2026-04-29T10:00:00Z")];
        let projects = vec![ProjectConfig {
            id: "abc".into(),
            path: PathBuf::from("C:\\Users\\joe\\repo"),
            name: "My Cool Repo".into(),
            avatar: Avatar::Emoji("🐉".into()),
            automation: Some(AutomationConfig {
                enabled: true,
                autostart_on_boot: false,
                session_name_prefix: None,
                continue_flag: false,
            }),
            created_at: "2026-04-01T00:00:00Z".into(),
            last_active_at: Some("2026-04-28T00:00:00Z".into()),
        }];
        let groups = build_groups(&projects, &history, &[], 0);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].id.as_deref(), Some("abc"));
        assert_eq!(groups[0].name, "My Cool Repo");
        assert!(groups[0].automation_enabled);
        assert!(matches!(groups[0].avatar, Avatar::Emoji(_)));
    }

    #[test]
    fn parent_segment_set_only_on_basename_collision() {
        let history = vec![
            token("C:\\Projects\\zng-app", 1, 1, "2026-04-29T10:00:00Z"),
            token("C:\\Projects\\Cinnamon\\zirtue\\zng-app", 1, 1, "2026-04-29T10:00:00Z"),
            token("C:\\Projects\\unique-name", 1, 1, "2026-04-29T10:00:00Z"),
        ];
        let groups = build_groups(&[], &history, &[], 0);
        let zng: Vec<_> = groups.iter().filter(|g| g.name == "zng-app").collect();
        assert_eq!(zng.len(), 2);
        for g in &zng {
            assert!(g.parent_segment.is_some(), "colliding groups must surface parent_segment");
        }
        let unique = groups.iter().find(|g| g.name == "unique-name").unwrap();
        assert!(unique.parent_segment.is_none(), "unique basenames must not have parent_segment");
    }

    #[test]
    fn live_instances_increment_live_and_flags() {
        let inst = Instance {
            session_id: "s1".into(),
            pid: 1,
            cwd: PathBuf::from("C:\\repo"),
            project_id: "x".into(),
            kind: InstanceKind::Automated,
            is_remote: true,
            started_at: "2026-04-29T10:00:00Z".into(),
            transcript_path: None,
            bridge_session_id: None,
            ended_at: None,
            end_reason: None,
        };
        let groups = build_groups(&[], &[], &[inst], 1714389600000);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].live, 1);
        assert!(groups[0].any_remote);
        assert!(groups[0].any_automated);
    }

    #[test]
    fn ended_instances_excluded() {
        let inst = Instance {
            session_id: "s1".into(),
            pid: 1,
            cwd: PathBuf::from("C:\\repo"),
            project_id: "x".into(),
            kind: InstanceKind::External,
            is_remote: false,
            started_at: "2026-04-29T10:00:00Z".into(),
            transcript_path: None,
            bridge_session_id: None,
            ended_at: Some("2026-04-29T11:00:00Z".into()),
            end_reason: Some(crate::types::EndReason::Manual),
        };
        let groups = build_groups(&[], &[], &[inst], 0);
        assert_eq!(groups.len(), 0, "ended instances must not appear");
    }
}
