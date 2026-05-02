use crate::state::AppState;
use crate::settings::paths;
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
