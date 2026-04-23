//! Display-cycle state for the tray. Pure logic — no Tauri deps.

use crate::tray::icon_render::DisplayMode;
use crate::tray::threshold::DefaultDisplay;
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
}
