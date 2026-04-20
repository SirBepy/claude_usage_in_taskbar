//! Notification firing: workFinished / questionAsked / thresholdCrossed.

use crate::audio;
use crate::icon_settings::NotifMode;
use crate::project_overrides::{self, ProjectOverrides};
use crate::state::AppState;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotifKind { WorkFinished, QuestionAsked, ThresholdCrossed }

#[derive(Default, Debug)]
pub struct NotifContext {
    pub name: Option<String>,
    pub percent: Option<u32>,
}

/// Resolves the active notification rule for this event + project.
/// Returns the project-specific override if one is enabled, else the global default.
pub fn resolve_notif_config(
    cfg: &crate::icon_settings::NotificationsConfig,
    overrides: &std::collections::HashMap<String, ProjectOverrides>,
    kind: NotifKind,
    cwd_key: Option<&str>,
) -> crate::icon_settings::NotificationRule {
    let default_rule = match kind {
        NotifKind::WorkFinished     => cfg.work_finished.clone(),
        NotifKind::QuestionAsked    => cfg.question_asked.clone(),
        NotifKind::ThresholdCrossed => cfg.threshold_crossed.clone(),
    };
    let Some(key) = cwd_key else { return default_rule; };
    let Some(po) = overrides.get(key) else { return default_rule; };
    let override_rule = match kind {
        NotifKind::WorkFinished     => po.work_finished.clone(),
        NotifKind::QuestionAsked    => po.question_asked.clone(),
        NotifKind::ThresholdCrossed => po.threshold_crossed.clone(),
    };
    override_rule.unwrap_or(default_rule)
}

pub fn fire(app: &AppHandle, kind: NotifKind, ctx: NotifContext, cwd_key: Option<&str>) {
    let settings = app.state::<AppState>().settings.lock().unwrap().clone();
    let cfg: crate::icon_settings::NotificationsConfig = (&settings).try_into().unwrap_or_default();
    let overrides = project_overrides::parse(&settings);
    let rule = resolve_notif_config(&cfg, &overrides, kind, cwd_key);
    if !rule.enabled { return; }
    match rule.mode {
        NotifMode::Sound => audio::play_pack_sound(app, &rule.sound_pack, &rule.sound_file),
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
        let status = crate::piper::status();
        let has_voice = status.voices.iter().any(|e| e.id == v && e.installed);
        if status.installed && has_voice {
            let app = app.clone();
            let text = text.to_string();
            let voice = v.to_string();
            tauri::async_runtime::spawn(async move {
                match crate::piper::synthesize(&text, &voice).await {
                    Ok(wav) => crate::audio::play_wav(&app, &wav),
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
        "text": text,
        "voiceName": voice,
    }));
}

pub fn speak_public(app: &AppHandle, text: &str, voice: Option<&str>) { speak(app, text, voice) }

#[cfg(test)]
mod tests {
    use super::*;

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
    fn resolver_returns_default_when_no_cwd() {
        use crate::icon_settings::NotificationsConfig;
        use std::collections::HashMap;
        let cfg = NotificationsConfig::default();
        let rule = resolve_notif_config(&cfg, &HashMap::new(), NotifKind::WorkFinished, None);
        assert_eq!(rule.sound_file, "sound1.mp3");
        assert_eq!(rule.sound_pack, "default");
    }

    #[test]
    fn resolver_returns_default_when_project_has_no_override() {
        use crate::icon_settings::NotificationsConfig;
        use std::collections::HashMap;
        let cfg = NotificationsConfig::default();
        let rule = resolve_notif_config(&cfg, &HashMap::new(), NotifKind::WorkFinished, Some("C:/x"));
        assert_eq!(rule.sound_file, "sound1.mp3");
    }

    #[test]
    fn resolver_returns_override_when_enabled() {
        use crate::icon_settings::{NotificationsConfig, NotifMode, NotificationRule};
        use crate::project_overrides::ProjectOverrides;
        use std::collections::HashMap;
        let cfg = NotificationsConfig::default();
        let mut map = HashMap::new();
        map.insert("C:/proj".into(), ProjectOverrides {
            work_finished: Some(NotificationRule {
                enabled: true, mode: NotifMode::Sound,
                sound_pack: "peon".into(), sound_file: "work-work.mp3".into(),
                voice_name: None, template: "".into(),
            }),
            ..Default::default()
        });
        let rule = resolve_notif_config(&cfg, &map, NotifKind::WorkFinished, Some("C:/proj"));
        assert_eq!(rule.sound_pack, "peon");
        assert_eq!(rule.sound_file, "work-work.mp3");
    }
}
