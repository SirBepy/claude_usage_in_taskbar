//! Display-cycle state for the tray. Pure logic — no Tauri deps.

use crate::tray::icon_render::DisplayMode;
use crate::tray::threshold::{DefaultDisplay, TrayContentMode, TrayNumberWindow};
use crate::types::UsageSnapshot;
use std::collections::HashMap;
use std::time::{Duration, Instant};

pub const RESET_AFTER: Duration = Duration::from_secs(60);

#[derive(Debug)]
pub struct TrayDisplayState {
    pub temp: Option<DisplayMode>,
    pub cycle: Vec<DisplayMode>,
    pub idx: usize,
    pub reset_deadline: Option<Instant>,
    pub spin_frame: Option<u32>,
}

impl Default for TrayDisplayState {
    fn default() -> Self {
        Self { temp: None, cycle: vec![], idx: 0, reset_deadline: None, spin_frame: None }
    }
}

pub fn build_cycle(default: DefaultDisplay) -> Vec<DisplayMode> {
    let all = [DisplayMode::Icon, DisplayMode::NumberSession, DisplayMode::NumberWeekly];
    let start_idx = match default {
        DefaultDisplay::Icon => 0,
        DefaultDisplay::Session => 1,
        DefaultDisplay::Weekly => 2,
    };
    let mut cycle = vec![all[start_idx]];
    for (i, m) in all.iter().enumerate() {
        if i != start_idx { cycle.push(*m); }
    }
    cycle
}

impl TrayDisplayState {
    pub fn cycle_next(&mut self, default: DefaultDisplay, now: Instant) {
        if self.cycle.is_empty() { self.cycle = build_cycle(default); self.idx = 0; }
        self.idx = (self.idx + 1) % self.cycle.len();
        self.temp = Some(self.cycle[self.idx]);
        self.reset_deadline = Some(now + RESET_AFTER);
    }

    pub fn tick(&mut self, now: Instant) -> bool {
        if let Some(deadline) = self.reset_deadline {
            if now >= deadline {
                self.temp = None;
                self.cycle.clear();
                self.idx = 0;
                self.reset_deadline = None;
                return true;
            }
        }
        false
    }

    pub fn invalidate_cycle(&mut self) {
        self.temp = None;
        self.cycle.clear();
        self.idx = 0;
        self.reset_deadline = None;
    }
}

pub fn effective_mode(default: DefaultDisplay, temp: Option<DisplayMode>) -> DisplayMode {
    temp.unwrap_or_else(|| match default {
        DefaultDisplay::Icon => DisplayMode::Icon,
        DefaultDisplay::Session => DisplayMode::NumberSession,
        DefaultDisplay::Weekly => DisplayMode::NumberWeekly,
    })
}

/// Multi-account milestone 06: maps the tray content-mode settings to the
/// icon renderer's `DisplayMode`. Pure so the mode-selection rule (glyph vs
/// number-and-which-window vs plain) is unit-testable without a tray/AppState.
pub fn resolve_tray_display_mode(mode: TrayContentMode, window: TrayNumberWindow) -> DisplayMode {
    match mode {
        TrayContentMode::Glyph => DisplayMode::Icon,
        TrayContentMode::Number => match window {
            TrayNumberWindow::FiveHour => DisplayMode::NumberSession,
            TrayNumberWindow::SevenDay => DisplayMode::NumberWeekly,
        },
        TrayContentMode::Nothing => DisplayMode::Plain,
    }
}

/// Multi-account milestone 06: picks which snapshot the tray face renders —
/// the chosen tray account's own per-account snapshot if one has been
/// polled, else the legacy single-account snapshot (pre-multi-account poll
/// path, or a freshly-chosen account this run hasn't polled yet). Pure over
/// borrowed data so it's testable without touching `AppState`.
pub fn pick_tray_snapshot<'a>(
    account_id: Option<&str>,
    by_account: &'a HashMap<String, UsageSnapshot>,
    legacy: Option<&'a UsageSnapshot>,
) -> Option<&'a UsageSnapshot> {
    if let Some(id) = account_id {
        if let Some(snap) = by_account.get(id) {
            return Some(snap);
        }
    }
    legacy
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_cycle_default_icon_starts_with_icon() {
        assert_eq!(
            build_cycle(DefaultDisplay::Icon),
            vec![DisplayMode::Icon, DisplayMode::NumberSession, DisplayMode::NumberWeekly],
        );
    }

    #[test]
    fn build_cycle_default_session_starts_with_session() {
        let c = build_cycle(DefaultDisplay::Session);
        assert_eq!(c[0], DisplayMode::NumberSession);
        assert_eq!(c.len(), 3);
    }

    #[test]
    fn cycle_next_wraps_after_three_clicks() {
        let mut st = TrayDisplayState::default();
        let now = Instant::now();
        st.cycle_next(DefaultDisplay::Icon, now);
        assert_eq!(st.temp, Some(DisplayMode::NumberSession));
        st.cycle_next(DefaultDisplay::Icon, now);
        assert_eq!(st.temp, Some(DisplayMode::NumberWeekly));
        st.cycle_next(DefaultDisplay::Icon, now);
        assert_eq!(st.temp, Some(DisplayMode::Icon));
    }

    #[test]
    fn tick_clears_temp_after_deadline() {
        let mut st = TrayDisplayState::default();
        let now = Instant::now();
        st.cycle_next(DefaultDisplay::Icon, now);
        assert!(st.temp.is_some());
        assert!(!st.tick(now));
        assert!(st.tick(now + RESET_AFTER + Duration::from_secs(1)));
        assert!(st.temp.is_none());
        assert!(st.cycle.is_empty());
    }

    #[test]
    fn effective_mode_uses_temp_when_present() {
        assert_eq!(effective_mode(DefaultDisplay::Icon, Some(DisplayMode::NumberWeekly)),
                   DisplayMode::NumberWeekly);
        assert_eq!(effective_mode(DefaultDisplay::Session, None),
                   DisplayMode::NumberSession);
    }

    #[test]
    fn resolve_tray_display_mode_glyph_is_icon() {
        assert_eq!(
            resolve_tray_display_mode(TrayContentMode::Glyph, TrayNumberWindow::SevenDay),
            DisplayMode::Icon,
        );
    }

    #[test]
    fn resolve_tray_display_mode_number_picks_window() {
        assert_eq!(
            resolve_tray_display_mode(TrayContentMode::Number, TrayNumberWindow::FiveHour),
            DisplayMode::NumberSession,
        );
        assert_eq!(
            resolve_tray_display_mode(TrayContentMode::Number, TrayNumberWindow::SevenDay),
            DisplayMode::NumberWeekly,
        );
    }

    #[test]
    fn resolve_tray_display_mode_nothing_is_plain() {
        assert_eq!(
            resolve_tray_display_mode(TrayContentMode::Nothing, TrayNumberWindow::FiveHour),
            DisplayMode::Plain,
        );
    }

    fn snap(utilization: f64) -> UsageSnapshot {
        UsageSnapshot {
            captured_at: "2026-07-07T00:00:00Z".into(),
            five_hour: crate::types::WindowUsage { utilization, resets_at: String::new() },
            seven_day: crate::types::WindowUsage { utilization, resets_at: String::new() },
            extra_usage: None,
            account_id: None,
        }
    }

    #[test]
    fn pick_tray_snapshot_prefers_the_chosen_account() {
        let mut by_account = HashMap::new();
        by_account.insert("acct-work".to_string(), snap(78.0));
        let legacy = snap(10.0);
        let picked = pick_tray_snapshot(Some("acct-work"), &by_account, Some(&legacy));
        assert_eq!(picked.map(|s| s.five_hour.utilization), Some(78.0));
    }

    #[test]
    fn pick_tray_snapshot_falls_back_to_legacy_when_account_unpolled() {
        let by_account: HashMap<String, UsageSnapshot> = HashMap::new();
        let legacy = snap(10.0);
        let picked = pick_tray_snapshot(Some("acct-work"), &by_account, Some(&legacy));
        assert_eq!(picked.map(|s| s.five_hour.utilization), Some(10.0));
    }

    #[test]
    fn pick_tray_snapshot_no_account_chosen_uses_legacy() {
        let by_account: HashMap<String, UsageSnapshot> = HashMap::new();
        let legacy = snap(42.0);
        let picked = pick_tray_snapshot(None, &by_account, Some(&legacy));
        assert_eq!(picked.map(|s| s.five_hour.utilization), Some(42.0));
    }

    #[test]
    fn pick_tray_snapshot_nothing_available_is_none() {
        let by_account: HashMap<String, UsageSnapshot> = HashMap::new();
        assert!(pick_tray_snapshot(Some("acct-work"), &by_account, None).is_none());
    }
}
