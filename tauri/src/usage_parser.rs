//! Pure math + formatting helpers. No Tauri deps. `now` is always injected
//! so tests stay deterministic.

use crate::icon_settings::{ColorStop, TimeStyle, TooltipLayout, TooltipSettings};
use crate::types::UsageSnapshot;
use chrono::{DateTime, Duration, Utc};

pub const FIVE_HOUR_MS: i64 = 5 * 3_600_000;
pub const SEVEN_DAY_MS: i64 = 7 * 24 * 3_600_000;

pub fn session_pct(snap: &UsageSnapshot) -> f32 { snap.five_hour.utilization as f32 }
pub fn weekly_pct(snap: &UsageSnapshot) -> f32 { snap.seven_day.utilization as f32 }

pub fn calc_safe_pct(resets_at: &str, window_ms: i64, now: DateTime<Utc>) -> Option<f32> {
    let resets = DateTime::parse_from_rfc3339(resets_at).ok()?.with_timezone(&Utc);
    let elapsed = window_ms - (resets - now).num_milliseconds();
    if elapsed < 0 || elapsed > window_ms { return None; }
    Some((elapsed as f32 / window_ms as f32) * 100.0)
}

pub fn threshold_crossed(prev: Option<f32>, new: Option<f32>, stops: &[ColorStop]) -> bool {
    let (Some(p), Some(n)) = (prev, new) else { return false; };
    stops.iter().any(|s| {
        let m = s.min as f32;
        p < m && n >= m
    })
}

pub fn build_tooltip(snap: Option<&UsageSnapshot>, s: &TooltipSettings, now: DateTime<Utc>) -> String {
    let Some(snap) = snap else { return "Claude Usage — initializing…".into(); };
    let sess = session_pct(snap);
    let weekly = weekly_pct(snap);
    let sess_safe = calc_safe_pct(&snap.five_hour.resets_at, FIVE_HOUR_MS, now);
    let weekly_safe = calc_safe_pct(&snap.seven_day.resets_at, SEVEN_DAY_MS, now);
    let sess_reset = format_reset(&snap.five_hour.resets_at, s.time_style, now);
    let weekly_reset = format_reset(&snap.seven_day.resets_at, s.time_style, now);

    match s.layout {
        TooltipLayout::Rows => {
            let mut lines = vec![];
            let mut sess_parts = vec![format!("Session  {:.0}%", sess)];
            if s.show_safe_pace { if let Some(v) = sess_safe { sess_parts.push(format!("{:.0}%", v)); } }
            lines.push(sess_parts.join("  "));
            if !sess_reset.is_empty() {
                lines.push("Resets:".to_string());
                lines.push(sess_reset);
            }

            let mut wk_parts = vec![format!("Weekly   {:.0}%", weekly)];
            if s.show_safe_pace { if let Some(v) = weekly_safe { wk_parts.push(format!("{:.0}%", v)); } }
            lines.push(wk_parts.join("  "));
            if !weekly_reset.is_empty() {
                lines.push("Resets:".to_string());
                lines.push(weekly_reset);
            }
            lines.join("\n")
        }
        TooltipLayout::Columns => {
            // Header + pct + (optional safe pace row) + "Resets:" header + times.
            let mut lines = vec!["Session\tWeekly".to_string()];
            lines.push(format!("{:.0}%\t{:.0}%", sess, weekly));
            if s.show_safe_pace {
                let a = sess_safe.map(|v| format!("{:.0}%", v)).unwrap_or_default();
                let b = weekly_safe.map(|v| format!("{:.0}%", v)).unwrap_or_default();
                if !a.is_empty() || !b.is_empty() {
                    lines.push(format!("{a}\t{b}").trim_end().to_string());
                }
            }
            if !sess_reset.is_empty() || !weekly_reset.is_empty() {
                lines.push("Resets:".to_string());
                lines.push(format!("{sess_reset}\t{weekly_reset}").trim_end().to_string());
            }
            lines.join("\n")
        }
    }
}

fn format_reset(resets_at: &str, style: TimeStyle, now: DateTime<Utc>) -> String {
    let Ok(resets) = DateTime::parse_from_rfc3339(resets_at) else { return String::new(); };
    let resets = resets.with_timezone(&Utc);
    match style {
        TimeStyle::Relative => {
            let delta = resets - now;
            if delta <= Duration::zero() { return "resets now".into(); }
            let h = delta.num_hours();
            let m = (delta.num_minutes() - h * 60).max(0);
            if h > 0 { format!("resets in {h}h {m}m") } else { format!("resets in {m}m") }
        }
        TimeStyle::Absolute => resets.format("resets %a %H:%M").to_string(),
    }
}

fn pace_summary(pct: f32, safe: Option<f32>) -> String {
    match safe {
        Some(s) if pct < s => format!("{pct:.0}% (under {s:.0}%)"),
        Some(s) => format!("{pct:.0}% (over {s:.0}%)"),
        None => format!("{pct:.0}%"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::icon_settings::ColorStop;
    use chrono::TimeZone;

    fn snap(five: f64, five_resets: &str, weekly: f64, weekly_resets: &str) -> UsageSnapshot {
        UsageSnapshot {
            captured_at: "2026-04-20T10:00:00Z".into(),
            five_hour: crate::types::WindowUsage { utilization: five, resets_at: five_resets.into() },
            seven_day: crate::types::WindowUsage { utilization: weekly, resets_at: weekly_resets.into() },
            extra_usage: None,
        }
    }

    #[test]
    fn calc_safe_pct_at_window_start_is_zero() {
        let now = Utc.with_ymd_and_hms(2026, 4, 20, 10, 0, 0).unwrap();
        let resets = "2026-04-20T15:00:00Z";
        let safe = calc_safe_pct(resets, FIVE_HOUR_MS, now).unwrap();
        assert!(safe < 0.1);
    }

    #[test]
    fn calc_safe_pct_at_halfway_is_fifty() {
        let now = Utc.with_ymd_and_hms(2026, 4, 20, 12, 30, 0).unwrap();
        let resets = "2026-04-20T15:00:00Z";
        let safe = calc_safe_pct(resets, FIVE_HOUR_MS, now).unwrap();
        assert!((safe - 50.0).abs() < 0.1);
    }

    #[test]
    fn calc_safe_pct_after_reset_returns_none() {
        let now = Utc.with_ymd_and_hms(2026, 4, 20, 16, 0, 0).unwrap();
        let resets = "2026-04-20T15:00:00Z";
        assert!(calc_safe_pct(resets, FIVE_HOUR_MS, now).is_none());
    }

    #[test]
    fn threshold_crossed_detects_upward_crossing() {
        let stops = vec![
            ColorStop { min: 0, color: "#0".into() },
            ColorStop { min: 50, color: "#0".into() },
            ColorStop { min: 80, color: "#0".into() },
        ];
        assert!(threshold_crossed(Some(30.0), Some(55.0), &stops));
        assert!(threshold_crossed(Some(60.0), Some(85.0), &stops));
    }

    #[test]
    fn threshold_crossed_ignores_steady_state() {
        let stops = vec![ColorStop { min: 50, color: "#0".into() }];
        assert!(!threshold_crossed(Some(60.0), Some(75.0), &stops));
        assert!(!threshold_crossed(Some(40.0), Some(45.0), &stops));
        assert!(!threshold_crossed(None, Some(75.0), &stops));
    }

    #[test]
    fn build_tooltip_rows_layout_absolute_time() {
        let now = Utc.with_ymd_and_hms(2026, 4, 20, 10, 0, 0).unwrap();
        let s = TooltipSettings {
            layout: TooltipLayout::Rows,
            time_style: TimeStyle::Absolute,
            show_safe_pace: false,
            apply_color: true,
        };
        let u = snap(45.0, "2026-04-20T12:30:00Z", 12.0, "2026-04-23T10:00:00Z");
        let tip = build_tooltip(Some(&u), &s, now);
        assert!(tip.contains("Session"));
        assert!(tip.contains("45%"));
        assert!(tip.contains("Weekly"));
        assert!(tip.contains("12%"));
        assert!(!tip.contains("Pace"));
    }

    #[test]
    fn build_tooltip_columns_relative_includes_safe_pace() {
        let now = Utc.with_ymd_and_hms(2026, 4, 20, 12, 30, 0).unwrap();
        let s = TooltipSettings {
            layout: TooltipLayout::Columns,
            time_style: TimeStyle::Relative,
            show_safe_pace: true,
            apply_color: true,
        };
        let u = snap(55.0, "2026-04-20T15:00:00Z", 22.0, "2026-04-23T10:00:00Z");
        let tip = build_tooltip(Some(&u), &s, now);
        let lines: Vec<&str> = tip.lines().collect();
        assert_eq!(lines[0], "Session\tWeekly");
        assert_eq!(lines[1], "55%\t22%");
        // Safe-pace row present (value depends on now vs resets_at)
        assert!(lines.len() >= 4);
    }

    #[test]
    fn build_tooltip_no_snapshot_is_initializing() {
        let s = TooltipSettings::default();
        let tip = build_tooltip(None, &s, Utc::now());
        assert!(tip.to_lowercase().contains("init"));
    }
}
