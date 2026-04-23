pub mod usage;
pub mod project;
pub mod automation;
pub mod notifications;

pub use usage::*;
pub use project::*;
pub use automation::*;
pub use notifications::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_defaults_roundtrip_json() {
        let s = Settings::default();
        let json = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(s, back);
    }

    #[test]
    fn settings_round_trip_preserves_extra_fields_from_dashboard() {
        let raw = r#"{
            "poll_interval_secs": 600,
            "display_mode": "rings",
            "threshold_warn": 50.0,
            "threshold_crit": 80.0,
            "autostart": true,
            "theme": "void",
            "projectAliases": { "C:/a": { "name": "Alpha" } },
            "projectBlacklist": ["C:/dead"],
            "notifications": { "workFinished": { "enabled": true } }
        }"#;
        let parsed: Settings = serde_json::from_str(raw).unwrap();
        let out = serde_json::to_value(&parsed).unwrap();

        assert_eq!(out["theme"], "void");
        assert_eq!(out["projectAliases"]["C:/a"]["name"], "Alpha");
        assert_eq!(out["projectBlacklist"][0], "C:/dead");
        assert_eq!(out["notifications"]["workFinished"]["enabled"], true);
    }

    #[test]
    fn settings_from_dashboard_payload_without_snake_case_fields() {
        let raw = r#"{
            "theme": "void",
            "defaultDisplay": "session",
            "iconStyle": "bars",
            "colorMode": "pace",
            "launchAtLogin": true,
            "autoUpdate": true,
            "colorThresholds": [],
            "notifications": {}
        }"#;
        let parsed: Settings = serde_json::from_str(raw).expect("must not fail");
        assert_eq!(parsed.extra["iconStyle"], "bars");
        assert_eq!(parsed.extra["defaultDisplay"], "session");
        assert_eq!(parsed.poll_interval_secs, 600);
        assert!(parsed.autostart);
        assert!(parsed.auto_update);
    }

    #[test]
    fn mute_flags_default_false_when_keys_missing() {
        let s = Settings::default();
        assert!(!s.mute_all());
        assert!(!s.mute_sounds());
        assert!(!s.mute_system_notifications());
    }

    #[test]
    fn mute_flags_read_from_extra_camel_case() {
        let raw = r#"{
            "muteAll": true,
            "muteSounds": false,
            "muteSystemNotifications": true
        }"#;
        let s: Settings = serde_json::from_str(raw).unwrap();
        assert!(s.mute_all());
        assert!(!s.mute_sounds());
        assert!(s.mute_system_notifications());
    }

    #[test]
    fn mute_flags_treat_wrong_type_as_false() {
        let raw = r#"{ "muteAll": "yes", "muteSounds": 1 }"#;
        let s: Settings = serde_json::from_str(raw).unwrap();
        assert!(!s.mute_all());
        assert!(!s.mute_sounds());
    }

    #[test]
    fn usage_snapshot_parses_real_api_shape() {
        let raw = r#"{
            "captured_at": "2026-04-19T10:00:00Z",
            "five_hour": { "utilization": 7.0, "resets_at": "2026-04-19T15:00:00Z" },
            "seven_day": { "utilization": 4.0, "resets_at": "2026-04-23T23:00:00Z" },
            "extra_usage": {
                "is_enabled": true, "monthly_limit": 8500,
                "used_credits": 329, "utilization": 3.87, "currency": "EUR"
            }
        }"#;
        let parsed: UsageSnapshot = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.five_hour.utilization, 7.0);
        assert_eq!(parsed.extra_usage.as_ref().unwrap().monthly_limit, 8500.0);
    }

    #[test]
    fn project_config_roundtrips_json() {
        let p = ProjectConfig {
            id: "abc".into(),
            path: std::path::PathBuf::from("C:/x/y"),
            name: "YProject".into(),
            avatar: Avatar::Emoji("🪶".into()),
            automation: None,
            created_at: "2026-04-21T00:00:00Z".into(),
            last_active_at: None,
        };
        let raw = serde_json::to_string(&p).unwrap();
        let back: ProjectConfig = serde_json::from_str(&raw).unwrap();
        assert_eq!(p, back);
    }

    #[test]
    fn settings_defaults_expose_new_fields() {
        let s = Settings::default();
        assert!(s.projects.is_empty());
        assert_eq!(s.projects_sort_by, ProjectsSortBy::Recent);
        assert!(!s.hooks_registered);
        assert!(!s.hook_registration_declined);
        assert_eq!(s.hook_install_version, 0);
    }

    #[test]
    fn avatar_serializes_as_tagged_enum() {
        let a = Avatar::Emoji("🦊".into());
        let raw = serde_json::to_string(&a).unwrap();
        assert_eq!(raw, r#"{"kind":"emoji","value":"🦊"}"#);
        let back: Avatar = serde_json::from_str(&raw).unwrap();
        assert_eq!(a, back);
    }

    #[test]
    fn instance_kind_serializes_lowercase() {
        let a = InstanceKind::Automated;
        let e = InstanceKind::External;
        assert_eq!(serde_json::to_string(&a).unwrap(), "\"automated\"");
        assert_eq!(serde_json::to_string(&e).unwrap(), "\"external\"");
    }

    #[test]
    fn end_reason_serializes_kebab_case() {
        let cases: Vec<(EndReason, &str)> = vec![
            (EndReason::HookSessionEnd, "\"hook-session-end\""),
            (EndReason::ProcessGone, "\"process-gone\""),
            (EndReason::ChildExit, "\"child-exit\""),
            (EndReason::Manual, "\"manual\""),
        ];
        for (r, expected) in cases {
            assert_eq!(serde_json::to_string(&r).unwrap(), expected);
        }
    }

    #[test]
    fn instance_roundtrips_json() {
        let i = Instance {
            session_id: "s1".into(),
            pid: 1234,
            cwd: std::path::PathBuf::from("C:/x"),
            project_id: "proj-a".into(),
            kind: InstanceKind::External,
            is_remote: false,
            started_at: "2026-04-21T10:00:00Z".into(),
            transcript_path: Some(std::path::PathBuf::from("C:/t/abc.jsonl")),
            bridge_session_id: None,
            ended_at: None,
            end_reason: None,
        };
        let raw = serde_json::to_string(&i).unwrap();
        let back: Instance = serde_json::from_str(&raw).unwrap();
        assert_eq!(i, back);
    }

    #[test]
    fn channel_status_serializes_lowercase() {
        assert_eq!(
            serde_json::to_string(&ChannelStatus::Running).unwrap(),
            "\"running\""
        );
    }
}
