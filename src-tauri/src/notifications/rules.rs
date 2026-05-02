//! Notification firing: workFinished / questionAsked / thresholdCrossed.

use crate::notifications::audio;
use crate::tray::{NotifMode, NotificationRule};
use crate::state::AppState;
use crate::types::{Avatar, Settings};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotifKind { WorkFinished, QuestionAsked, ThresholdCrossed }

#[derive(Default, Debug)]
pub struct NotifContext {
    pub name: Option<String>,
    pub percent: Option<u32>,
}

/// Sentinel used in `NotificationRule.sound_pack` to indicate that
/// `sound_file` carries an absolute path resolved from a character slot.
pub const CHARACTER_PACK_SENTINEL: &str = "__character__";

/// Character-aware resolver. For `WorkFinished` / `QuestionAsked`, if the
/// project at `cwd_key` has `Avatar::Character(id)` and that character has a
/// non-empty slot, returns a synthetic rule whose `sound_file` is an absolute
/// path. Otherwise returns the global default rule for the kind.
/// `ThresholdCrossed` always returns the global default.
pub fn resolve_with_character(
    cfg: &crate::tray::NotificationsConfig,
    settings: &Settings,
    kind: NotifKind,
    cwd_key: Option<&str>,
) -> NotificationRule {
    let default_rule = match kind {
        NotifKind::WorkFinished     => cfg.work_finished.clone(),
        NotifKind::QuestionAsked    => cfg.question_asked.clone(),
        NotifKind::ThresholdCrossed => cfg.threshold_crossed.clone(),
    };
    if matches!(kind, NotifKind::ThresholdCrossed) { return default_rule; }
    let Some(key) = cwd_key else { return default_rule; };
    let Some(proj) = settings.projects.iter().find(|p| {
        crate::settings::store::project_key(&p.path) == key
    }) else { return default_rule; };
    let Avatar::Character(char_id) = &proj.avatar else { return default_rule; };
    let Some(character) = crate::characters::get(char_id) else { return default_rule; };
    let slot = match kind {
        NotifKind::WorkFinished  => crate::characters::slots::Slot::WorkFinished,
        NotifKind::QuestionAsked => crate::characters::slots::Slot::QuestionAsked,
        NotifKind::ThresholdCrossed => unreachable!(),
    };
    let files = character.slot_files(slot);
    let Some(pick) = crate::characters::slots::random_pick(files) else { return default_rule; };
    let Ok(dir) = crate::settings::paths::characters_dir() else { return default_rule; };
    let abs = character.asset_path(&dir, pick);
    NotificationRule {
        enabled: true,
        mode: NotifMode::Sound,
        sound_pack: CHARACTER_PACK_SENTINEL.into(),
        sound_file: abs.to_string_lossy().into_owned(),
        voice_name: None,
        template: String::new(),
    }
}

pub(crate) fn should_suppress(settings: &Settings, mode: NotifMode) -> bool {
    if settings.mute_all() { return true; }
    matches!(mode, NotifMode::Sound | NotifMode::Voice) && settings.mute_sounds()
}

pub fn fire(app: &AppHandle, kind: NotifKind, ctx: NotifContext, cwd_key: Option<&str>) {
    let state = app.state::<AppState>();
    let settings_snapshot = state.settings.lock().unwrap().clone();
    let cfg: crate::tray::NotificationsConfig = (&settings_snapshot).try_into().unwrap_or_default();
    let rule = resolve_with_character(&cfg, &settings_snapshot, kind, cwd_key);
    if !rule.enabled { return; }
    if should_suppress(&settings_snapshot, rule.mode) { return; }
    match rule.mode {
        NotifMode::Sound => {
            if rule.sound_pack == CHARACTER_PACK_SENTINEL {
                audio::play_path(app, std::path::Path::new(&rule.sound_file));
            } else {
                audio::play_sound_file(app, &rule.sound_file);
            }
        }
        NotifMode::Voice => {
            let text = render_template(&rule.template, &ctx);
            if text.is_empty() { return; }
            speak(app, &text, rule.voice_name.as_deref());
        }
    }
}

pub fn render_template(tpl: &str, ctx: &NotifContext) -> String {
    let name = sanitize(ctx.name.as_deref().unwrap_or(""));
    let pct = ctx.percent.map(|p| format!("{p}%")).unwrap_or_default();
    sanitize(&tpl.replace("{name}", &name).replace("{percent}", &pct))
}

fn sanitize(s: &str) -> String {
    let mapped: String = s.chars()
        .map(|c| if matches!(c, '_' | '-') { ' ' } else { c })
        .collect();
    mapped.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn project_name_from_cwd(cwd: &str) -> Option<String> {
    let last = cwd.rsplit(|c| c == '/' || c == '\\').next()?.to_string();
    if last.is_empty() { None } else { Some(last) }
}

fn speak(app: &AppHandle, text: &str, voice: Option<&str>) {
    if let Some(v) = voice {
        let status = crate::notifications::piper::status();
        let has_voice = status.voices.iter().any(|e| e.id == v && e.installed);
        if status.installed && has_voice {
            let app = app.clone();
            let text = text.to_string();
            let voice = v.to_string();
            tauri::async_runtime::spawn(async move {
                match crate::notifications::piper::synthesize(&text, &voice).await {
                    Ok(wav) => audio::play_wav(&app, &wav),
                    Err(e) => {
                        log::warn!("piper synth failed: {e}; falling back to web speech");
                        let _ = app.emit("speak-fallback", serde_json::json!({
                            "text": text, "voiceName": voice,
                        }));
                    }
                }
            });
            return;
        }
    }
    let _ = app.emit("speak-fallback", serde_json::json!({
        "text": text, "voiceName": voice,
    }));
}

pub fn speak_public(app: &AppHandle, text: &str, voice: Option<&str>) { speak(app, text, voice) }

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tray::NotificationsConfig;
    use crate::types::{Avatar, ProjectConfig};

    fn settings_with_project(path: &str, character_id: Option<&str>) -> Settings {
        let mut s = Settings::default();
        let avatar = match character_id {
            Some(id) => Avatar::Character(id.into()),
            None => Avatar::None,
        };
        s.projects.push(ProjectConfig {
            id: "test-id".into(),
            path: std::path::PathBuf::from(path),
            name: "test".into(),
            avatar,
            automation: None,
            created_at: "2026-05-02T00:00:00Z".into(),
            last_active_at: None,
        });
        s
    }

    #[test]
    fn should_suppress_returns_false_when_all_flags_off() {
        let s = Settings::default();
        assert!(!should_suppress(&s, NotifMode::Sound));
        assert!(!should_suppress(&s, NotifMode::Voice));
    }

    #[test]
    fn should_suppress_returns_true_when_mute_all_regardless_of_mode() {
        let mut s = Settings::default();
        s.extra.insert("muteAll".into(), serde_json::Value::Bool(true));
        assert!(should_suppress(&s, NotifMode::Sound));
        assert!(should_suppress(&s, NotifMode::Voice));
    }

    #[test]
    fn should_suppress_mutes_sound_and_voice_when_mute_sounds() {
        let mut s = Settings::default();
        s.extra.insert("muteSounds".into(), serde_json::Value::Bool(true));
        assert!(should_suppress(&s, NotifMode::Sound));
        assert!(should_suppress(&s, NotifMode::Voice));
    }

    #[test]
    fn template_substitutes_name() {
        let out = render_template("{name} is done", &NotifContext {
            name: Some("my_project".into()), percent: None,
        });
        assert_eq!(out, "my project is done");
    }

    #[test]
    fn template_substitutes_percent() {
        let out = render_template("{percent} threshold", &NotifContext {
            name: None, percent: Some(80),
        });
        assert_eq!(out, "80% threshold");
    }

    #[test]
    fn sanitize_collapses_whitespace_and_underscores() {
        assert_eq!(sanitize("foo_bar   baz-quux"), "foo bar baz quux");
    }

    #[test]
    fn project_name_last_path_component() {
        assert_eq!(project_name_from_cwd("C:\\Users\\tecno\\Desktop\\alpha"), Some("alpha".into()));
        assert_eq!(project_name_from_cwd("/home/tecno/beta"), Some("beta".into()));
        assert_eq!(project_name_from_cwd(""), None);
    }

    #[test]
    fn character_resolver_falls_back_to_global_when_no_cwd() {
        let cfg = NotificationsConfig::default();
        let s = Settings::default();
        let rule = resolve_with_character(&cfg, &s, NotifKind::WorkFinished, None);
        assert_eq!(rule.sound_pack, "default");
    }

    #[test]
    fn character_resolver_falls_back_to_global_when_no_project_match() {
        let cfg = NotificationsConfig::default();
        let s = Settings::default();
        let rule = resolve_with_character(&cfg, &s, NotifKind::WorkFinished, Some("C:/missing"));
        assert_eq!(rule.sound_pack, "default");
    }

    #[test]
    fn character_resolver_falls_back_to_global_when_avatar_is_not_character() {
        let cfg = NotificationsConfig::default();
        let s = settings_with_project("C:/proj", None);
        let key = crate::settings::store::project_key(std::path::Path::new("C:/proj"));
        let rule = resolve_with_character(&cfg, &s, NotifKind::WorkFinished, Some(&key));
        assert_eq!(rule.sound_pack, "default");
    }

    #[test]
    fn character_resolver_returns_global_for_threshold_crossed_even_with_character() {
        let cfg = NotificationsConfig::default();
        let s = settings_with_project("C:/proj", Some("peon"));
        let key = crate::settings::store::project_key(std::path::Path::new("C:/proj"));
        let rule = resolve_with_character(&cfg, &s, NotifKind::ThresholdCrossed, Some(&key));
        assert_eq!(rule.sound_pack, "default");
    }

    #[test]
    fn character_resolver_falls_back_to_global_when_character_not_installed() {
        let cfg = NotificationsConfig::default();
        let s = settings_with_project("C:/proj", Some("nonexistent-character"));
        let key = crate::settings::store::project_key(std::path::Path::new("C:/proj"));
        let rule = resolve_with_character(&cfg, &s, NotifKind::WorkFinished, Some(&key));
        assert_eq!(rule.sound_pack, "default");
    }
}
