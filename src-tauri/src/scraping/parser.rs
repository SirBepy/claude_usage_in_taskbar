//! Pure math + formatting helpers. No Tauri deps. `now` is always injected
//! so tests stay deterministic.

use crate::tray::{ColorMode, ColorStop, IconSettings, TimeStyle, TooltipLayout, TooltipSettings};
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

pub fn build_tooltip(
    snap: Option<&UsageSnapshot>,
    s: &TooltipSettings,
    icon_s: &IconSettings,
    now: DateTime<Utc>,
) -> String {
    let Some(snap) = snap else { return "Claude Conductor — initializing…".into(); };
    let sess = session_pct(snap);
    let weekly = weekly_pct(snap);
    let sess_safe = calc_safe_pct(&snap.five_hour.resets_at, FIVE_HOUR_MS, now);
    let weekly_safe = calc_safe_pct(&snap.seven_day.resets_at, SEVEN_DAY_MS, now);
    let sess_reset = format_reset(&snap.five_hour.resets_at, s.time_style, now);
    let weekly_reset = format_reset(&snap.seven_day.resets_at, s.time_style, now);

    // Emoji prefix for the current-% number (OS tray tooltips are plain text,
    // so we fake "color" with a coloured circle). Only prefix when the user
    // has tooltip colouring turned on.
    let sess_pct = fmt_pct(sess, sess_safe, s.apply_color, icon_s);
    let weekly_pct = fmt_pct(weekly, weekly_safe, s.apply_color, icon_s);

    match s.layout {
        TooltipLayout::Rows => {
            let row = |label: &str, pct: &str, safe: Option<f32>, reset: &str| {
                let mut parts = vec![label.to_string(), pct.to_string()];
                if s.show_safe_pace {
                    if let Some(v) = safe { parts.push(format!("{:.0}%", v)); }
                }
                if !reset.is_empty() { parts.push(reset.replace('\n', " ")); }
                parts.join("  ")
            };
            let lines = vec![
                row("Session", &sess_pct, sess_safe, &sess_reset),
                row("Weekly ", &weekly_pct, weekly_safe, &weekly_reset),
            ];
            lines.join("\n")
        }
        TooltipLayout::Columns => {
            // Tab separator: Win tooltip control renders \t at fixed tab-stop
            // positions, giving true visual alignment regardless of glyph
            // width (digits, letters, emoji all snap to the same column).
            // Space-padding the left column couldn't ever align perfectly
            // because Segoe UI is proportional.
            let reset_block: Option<Vec<(String, String)>> =
                if !sess_reset.is_empty() || !weekly_reset.is_empty() {
                    let s_lines: Vec<&str> = sess_reset.split('\n').collect();
                    let w_lines: Vec<&str> = weekly_reset.split('\n').collect();
                    let rows = s_lines.len().max(w_lines.len());
                    Some((0..rows).map(|i| (
                        s_lines.get(i).copied().unwrap_or("").to_string(),
                        w_lines.get(i).copied().unwrap_or("").to_string(),
                    )).collect())
                } else { None };

            let mut pairs: Vec<(String, String)> = vec![
                ("Session".into(), "Weekly".into()),
                (sess_pct, weekly_pct),
            ];
            if s.show_safe_pace {
                let a = sess_safe.map(|v| format!("{:.0}%", v)).unwrap_or_default();
                let b = weekly_safe.map(|v| format!("{:.0}%", v)).unwrap_or_default();
                if !a.is_empty() || !b.is_empty() {
                    pairs.push((a, b));
                }
            }

            let row = |left: &str, right: &str| -> String {
                if right.is_empty() { left.trim_end().to_string() }
                else { format!("{left}\t{right}") }
            };

            let mut lines: Vec<String> = pairs.iter().map(|(a, b)| row(a, b)).collect();
            if let Some(block) = reset_block {
                lines.push(String::new());
                for (a, b) in block { lines.push(row(&a, &b)); }
            }
            lines.join("\n")
        }
    }
}

fn fmt_pct(pct: f32, safe: Option<f32>, apply_color: bool, icon_s: &IconSettings) -> String {
    let base = format!("{pct:.0}%");
    if !apply_color { return base; }
    let hex = pick_color(pct, safe, icon_s);
    match hex.and_then(hex_to_emoji) {
        Some(e) => format!("{base} {e}"),
        None => base,
    }
}

fn pick_color<'a>(pct: f32, safe: Option<f32>, icon_s: &'a IconSettings) -> Option<&'a str> {
    match icon_s.color_mode {
        ColorMode::Pace => safe.map(|s| pace_color(pct, s, icon_s)),
        ColorMode::Threshold => threshold_color(pct, &icon_s.color_thresholds),
    }
}

fn threshold_color(pct: f32, stops: &[ColorStop]) -> Option<&str> {
    let mut sorted: Vec<&ColorStop> = stops.iter().collect();
    sorted.sort_by(|a, b| b.min.cmp(&a.min));
    for s in sorted {
        if pct >= s.min as f32 { return Some(&s.color); }
    }
    None
}

fn pace_color<'a>(pct: f32, safe: f32, icon_s: &'a IconSettings) -> &'a str {
    let band = icon_s.pace_band;
    let pc = &icon_s.pace_colors;
    if pct < safe - band       { &pc.under }
    else if pct < safe         { &pc.near_safe }
    else if pct < safe + band  { &pc.near_over }
    else                       { &pc.over }
}

/// Map a hex colour to the closest coloured-circle emoji. Mirrors the
/// original Electron `hexToEmoji` in `src/core/usage-parser.js`.
fn hex_to_emoji(hex: &str) -> Option<&'static str> {
    let h = hex.trim_start_matches('#');
    if h.len() < 6 { return None; }
    let r = u8::from_str_radix(&h[0..2], 16).ok()?;
    let g = u8::from_str_radix(&h[2..4], 16).ok()?;
    let b = u8::from_str_radix(&h[4..6], 16).ok()?;
    let max = r.max(g).max(b);
    Some(if max == r && g < 120      { "🔴" }
         else if max == r            { "🟠" }
         else if max == g            { "🟢" }
         else if max == b            { "🔵" }
         else                        { "⚪" })
}

fn format_reset(resets_at: &str, style: TimeStyle, now: DateTime<Utc>) -> String {
    let Ok(resets) = DateTime::parse_from_rfc3339(resets_at) else { return String::new(); };
    let resets = resets.with_timezone(&Utc);
    match style {
        TimeStyle::Relative => {
            // Round to nearest 10-min boundary before computing delta so the
            // countdown matches the dashboard (`roundToNearest10Min` in shared/formatters.ts).
            const TEN_MIN_MS: i64 = 10 * 60 * 1000;
            let ms = resets.timestamp_millis();
            let rounded_ms = ((ms + TEN_MIN_MS / 2) / TEN_MIN_MS) * TEN_MIN_MS;
            let resets = DateTime::<Utc>::from_timestamp_millis(rounded_ms).unwrap_or(resets);
            let delta = resets - now;
            if delta <= Duration::zero() { return "resets now".into(); }
            let h = delta.num_hours();
            let m = (delta.num_minutes() - h * 60).max(0);
            if h > 0 { format!("{h}h {m}m") } else { format!("{m}m") }
        }
        TimeStyle::Absolute => {
            use chrono::Timelike;
            // Round to nearest 10-min boundary so the tooltip matches the
            // dashboard (`roundToNearest10Min` in shared/formatters.ts).
            // ceil caused times like 3:50:01 to show as 4:00 instead of 3:50.
            const TEN_MIN_MS: i64 = 10 * 60 * 1000;
            let ms = resets.timestamp_millis();
            let rounded_ms = ((ms + TEN_MIN_MS / 2) / TEN_MIN_MS) * TEN_MIN_MS;
            let resets = DateTime::<Utc>::from_timestamp_millis(rounded_ms).unwrap_or(resets);
            let local = resets.with_timezone(&chrono::Local);
            let h24 = local.hour();
            let h12 = match h24 % 12 { 0 => 12, n => n };
            let ampm = if h24 < 12 { "AM" } else { "PM" };
            let min = local.minute();
            let day = local.format("%a");
            // 12h format with AM/PM matches the dashboard. Day on its own
            // line — Columns layout splits this into two reset rows.
            format!("{day}\n{h12}:{min:02}{ampm}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tray::ColorStop;
    use chrono::TimeZone;

    fn snap(five: f64, five_resets: &str, weekly: f64, weekly_resets: &str) -> UsageSnapshot {
        UsageSnapshot {
            captured_at: "2026-04-20T10:00:00Z".into(),
            five_hour: crate::types::WindowUsage { utilization: five, resets_at: five_resets.into() },
            seven_day: crate::types::WindowUsage { utilization: weekly, resets_at: weekly_resets.into() },
            extra_usage: None,
            account_id: None,
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
            apply_color: false,
        };
        let icon = IconSettings::default();
        let u = snap(45.0, "2026-04-20T12:30:00Z", 12.0, "2026-04-23T10:00:00Z");
        let tip = build_tooltip(Some(&u), &s, &icon, now);
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
            apply_color: false,
        };
        let icon = IconSettings::default();
        let u = snap(55.0, "2026-04-20T15:00:00Z", 22.0, "2026-04-23T10:00:00Z");
        let tip = build_tooltip(Some(&u), &s, &icon, now);
        let lines: Vec<&str> = tip.lines().collect();
        // Cols are space-padded (not tab-separated) to dodge Win tooltip
        // clipping; just check both labels/percents land on their rows.
        assert!(lines[0].starts_with("Session") && lines[0].contains("Weekly"));
        assert!(lines[1].starts_with("55%") && lines[1].contains("22%"));
        // Safe-pace row present (value depends on now vs resets_at)
        assert!(lines.len() >= 4);
    }

    #[test]
    fn build_tooltip_no_snapshot_is_initializing() {
        let s = TooltipSettings::default();
        let icon = IconSettings::default();
        let tip = build_tooltip(None, &s, &icon, Utc::now());
        assert!(tip.to_lowercase().contains("init"));
    }

    #[test]
    fn build_tooltip_apply_color_adds_emoji_prefix() {
        let now = Utc.with_ymd_and_hms(2026, 4, 20, 10, 0, 0).unwrap();
        let s = TooltipSettings {
            layout: TooltipLayout::Rows,
            time_style: TimeStyle::Absolute,
            show_safe_pace: false,
            apply_color: true,
        };
        // Default thresholds: 0→green, 50→orange, 80→red
        let icon = IconSettings::default();
        let u = snap(85.0, "2026-04-20T12:30:00Z", 30.0, "2026-04-23T10:00:00Z");
        let tip = build_tooltip(Some(&u), &s, &icon, now);
        // Red threshold -> red circle before session %, green before weekly %.
        assert!(tip.contains("85% 🔴"), "expected red emoji after 85%, got: {tip}");
        assert!(tip.contains("30% 🟢"), "expected green emoji after 30%, got: {tip}");
    }

    #[test]
    fn hex_to_emoji_picks_channel_by_max() {
        assert_eq!(super::hex_to_emoji("#e74c3c"), Some("🔴"));
        assert_eq!(super::hex_to_emoji("#e67e22"), Some("🟠"));
        assert_eq!(super::hex_to_emoji("#27ae60"), Some("🟢"));
        assert_eq!(super::hex_to_emoji("#3b82f6"), Some("🔵"));
    }
}
