use crate::state::AppState;
use crate::settings::paths;
use std::path::Path;
use std::time::UNIX_EPOCH;
use tauri::State;

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
            let entry = by_key.entry(key.clone()).or_insert_with(|| empty_group(cwd));
            entry.tokens_7d = entry.tokens_7d.saturating_add(rec.input_tokens + rec.output_tokens);
            update_last_active(&mut entry.last_active_at, &rec.last_active_at);
            update_last_active(&mut entry.last_active_at, &rec.started_at);
        }

        // 2. Layer settings.projects on top.
        for p in projects {
            let key = project_key(&p.path);
            let entry = by_key
                .entry(key.clone())
                .or_insert_with(|| empty_group(&p.path.to_string_lossy()));
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
                .or_insert_with(|| empty_group(&inst.cwd.to_string_lossy()));
            entry.live = entry.live.saturating_add(1);
            entry.any_remote = entry.any_remote || inst.is_remote;
            entry.any_automated = entry.any_automated
                || matches!(inst.kind, crate::sessions::kinds::InstanceKind::Automated);
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

    fn empty_group(raw_path: &str) -> ProjectGroup {
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
            path_exists: true,
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

#[tauri::command]
pub async fn list_project_groups(state: State<'_, AppState>) -> Result<Vec<crate::types::ProjectGroup>, ()> {
    let projects = state.settings.lock().unwrap().projects.clone();
    let instances = state.cached_instances.lock().unwrap().clone();
    let now_ms = chrono::Utc::now().timestamp_millis();
    let groups = tauri::async_runtime::spawn_blocking(move || {
        let token_history = match paths::token_history_file() {
            Ok(p) => crate::tokens::load_history(&p),
            Err(_) => Vec::new(),
        };
        let mut groups = groups_test_helpers::build_groups(&projects, &token_history, &instances, now_ms);
        for g in &mut groups {
            g.path_exists = Path::new(&g.path).exists();
        }
        groups
    })
    .await
    .unwrap_or_default();
    Ok(groups)
}

/// Computes the latest `mtime` of any `.jsonl` under
/// `~/.claude/projects/<encoded-cwd>/` for the given cwd, returned as
/// Unix-epoch seconds. Returns `0` when the directory is missing, empty,
/// or contains no `.jsonl` files. Used by the Sessions "Most recent" sort
/// in the new-session project-picker modal.
#[tauri::command]
pub async fn project_last_activity_at(cwd: String) -> Result<i64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        latest_jsonl_mtime_in_projects_dir(Path::new(&cwd))
    })
    .await
    .map_err(|e| e.to_string())
}

/// Returns max-mtime epoch seconds across `*.jsonl` in
/// `~/.claude/projects/<encoded-cwd>/`. 0 if dir absent, unreadable, or
/// has no jsonl files. Errors are swallowed - this is best-effort sort
/// metadata, not load-bearing.
fn latest_jsonl_mtime_in_projects_dir(cwd: &Path) -> i64 {
    let Some(home) = dirs::home_dir() else { return 0 };
    let encoded = crate::tokens::encode_cwd_as_project_dir(cwd);
    let dir = home.join(".claude").join("projects").join(encoded);
    max_jsonl_mtime(&dir)
}

/// Pure helper: walks `dir` for `*.jsonl` files and returns the max
/// mtime as Unix-epoch seconds. 0 if dir missing or no jsonl found.
fn max_jsonl_mtime(dir: &Path) -> i64 {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    let mut best: i64 = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(modified) = meta.modified() else { continue };
        let secs = modified
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        if secs > best {
            best = secs;
        }
    }
    best
}

#[cfg(test)]
mod build_groups_tests {
    use super::groups_test_helpers::build_groups;
    use crate::tokens::TokenRecord;
    use crate::sessions::kinds::InstanceKind;
    use crate::types::{
        AutomationConfig, Avatar, Instance, ProjectConfig,
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
            whitelist: crate::types::CharacterWhitelist::default(),
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
            name: None,
            ended_at: None,
            end_reason: None,
            busy: false,
            model: String::new(),
            effort: String::new(),
            awaiting: None,
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
            name: None,
            ended_at: Some("2026-04-29T11:00:00Z".into()),
            end_reason: Some(crate::types::EndReason::Manual),
            busy: false,
            model: String::new(),
            effort: String::new(),
            awaiting: None,
        };
        let groups = build_groups(&[], &[], &[inst], 0);
        assert_eq!(groups.len(), 0, "ended instances must not appear");
    }
}

#[cfg(test)]
mod last_activity_tests {
    use super::max_jsonl_mtime;
    use std::path::Path;
    use tempfile::tempdir;

    #[test]
    fn returns_zero_for_missing_dir() {
        assert_eq!(max_jsonl_mtime(Path::new("/definitely/does/not/exist/zzz")), 0);
    }

    #[test]
    fn returns_zero_for_dir_with_no_jsonl() {
        let d = tempdir().unwrap();
        std::fs::write(d.path().join("foo.txt"), "").unwrap();
        std::fs::write(d.path().join("bar.json"), "").unwrap();
        assert_eq!(max_jsonl_mtime(d.path()), 0);
    }

    #[test]
    fn returns_max_mtime_among_jsonl_files() {
        let d = tempdir().unwrap();
        let a = d.path().join("a.jsonl");
        let b = d.path().join("b.jsonl");
        let c = d.path().join("c.txt");
        std::fs::write(&a, "").unwrap();
        std::fs::write(&b, "").unwrap();
        std::fs::write(&c, "").unwrap();
        // Touch b last so it has the larger mtime; on fast filesystems
        // a and b can share a timestamp - sleep a beat to force ordering.
        std::thread::sleep(std::time::Duration::from_millis(10));
        std::fs::write(&b, "newer").unwrap();
        let got = max_jsonl_mtime(d.path());
        assert!(got > 0, "expected non-zero mtime, got {got}");
        // .txt file must not influence result; only jsonl files count.
        // We verify by also writing a much-newer .txt and re-checking.
        std::thread::sleep(std::time::Duration::from_millis(10));
        std::fs::write(&c, "much-newer-txt").unwrap();
        let got2 = max_jsonl_mtime(d.path());
        assert_eq!(got, got2, "non-jsonl file must not affect mtime");
    }
}
