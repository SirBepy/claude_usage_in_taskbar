//! Self-calibrating $/quota model. We never see Anthropic's dollar limits
//! directly, but we DO see (a) the dollar drain of sessions active in a window
//! and (b) the window's utilization percent. Dividing one by the other gives an
//! instantaneous estimate of the window's total dollar quota, which we smooth
//! with an EWMA so a single noisy sample can't swing the displayed quota.

use std::path::Path;

/// EWMA smoothing factor. Lower = steadier, slower to react.
const ALPHA: f64 = 0.2;
/// Minimum utilization (percent) before we trust a window's sample. Below this,
/// `drain / (util/100)` divides by near-noise and explodes, so we carry the
/// previous estimate instead.
const UTIL_FLOOR_PCT: f64 = 5.0;

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionQuota {
    pub quota_5h_usd: f64,
    pub quota_weekly_usd: f64,
    pub samples: u32,
    pub updated_at: String,
}

/// Loads the persisted quota estimate. A missing or corrupt file yields the
/// `Default` (all-zero) quota - never an error, never a panic.
pub fn load_quota(path: &Path) -> SessionQuota {
    let Ok(raw) = std::fs::read_to_string(path) else { return SessionQuota::default() };
    if raw.trim().is_empty() { return SessionQuota::default() }
    serde_json::from_str(&raw).unwrap_or_default()
}

/// Persists the quota estimate, creating the parent dir if needed.
pub fn save_quota(path: &Path, q: &SessionQuota) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let json = serde_json::to_string_pretty(q)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    std::fs::write(path, json)
}

/// EWMA one window toward its instantaneous estimate. Below the utilization
/// floor the instantaneous estimate is divide-by-noise, so we carry `prev`.
fn calibrate_window(prev: f64, visible_drain: f64, util_pct: f64) -> f64 {
    if util_pct < UTIL_FLOOR_PCT {
        return prev;
    }
    let instantaneous = visible_drain / (util_pct / 100.0);
    if prev <= 0.0 {
        // First real sample seeds the EWMA directly.
        instantaneous
    } else {
        prev + ALPHA * (instantaneous - prev)
    }
}

/// Folds one observation into the running quota estimate. `visible_drain_*` is
/// the summed drain of sessions active in the window; `util_*_pct` is a PERCENT
/// (7.0 = 7%). A window whose util is below the floor carries its previous value.
pub fn calibrate(
    prev: &SessionQuota,
    visible_drain_5h: f64,
    util_5h_pct: f64,
    visible_drain_7d: f64,
    util_7d_pct: f64,
) -> SessionQuota {
    let quota_5h_usd = calibrate_window(prev.quota_5h_usd, visible_drain_5h, util_5h_pct);
    let quota_weekly_usd = calibrate_window(prev.quota_weekly_usd, visible_drain_7d, util_7d_pct);
    SessionQuota {
        quota_5h_usd,
        quota_weekly_usd,
        samples: prev.samples.saturating_add(1),
        updated_at: chrono::Utc::now().to_rfc3339(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn save_load_roundtrips() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("session-quota.json");
        let q = SessionQuota {
            quota_5h_usd: 12.5,
            quota_weekly_usd: 300.0,
            samples: 7,
            updated_at: "2026-06-20T00:00:00+00:00".into(),
        };
        save_quota(&path, &q).unwrap();
        let back = load_quota(&path);
        assert_eq!(back.quota_5h_usd, 12.5);
        assert_eq!(back.quota_weekly_usd, 300.0);
        assert_eq!(back.samples, 7);
        assert_eq!(back.updated_at, "2026-06-20T00:00:00+00:00");
    }

    #[test]
    fn load_missing_or_corrupt_is_default() {
        let dir = tempdir().unwrap();
        assert_eq!(load_quota(&dir.path().join("nope.json")).samples, 0);
        let corrupt = dir.path().join("c.json");
        std::fs::write(&corrupt, "{ not json").unwrap();
        let q = load_quota(&corrupt);
        assert_eq!(q.samples, 0);
        assert_eq!(q.quota_5h_usd, 0.0);
    }

    #[test]
    fn calibrate_below_floor_carries_previous() {
        let prev = SessionQuota {
            quota_5h_usd: 20.0,
            quota_weekly_usd: 500.0,
            samples: 3,
            ..Default::default()
        };
        // Both windows below the 5% floor: values must be carried verbatim.
        let next = calibrate(&prev, 0.1, 1.0, 0.5, 2.0);
        assert_eq!(next.quota_5h_usd, 20.0, "below-floor 5h carries previous");
        assert_eq!(next.quota_weekly_usd, 500.0, "below-floor weekly carries previous");
        assert_eq!(next.samples, 4, "samples still increments");
    }

    #[test]
    fn calibrate_above_floor_moves_toward_instantaneous() {
        let prev = SessionQuota {
            quota_5h_usd: 10.0,
            quota_weekly_usd: 100.0,
            samples: 1,
            ..Default::default()
        };
        // 5h: drain $2 at 10% util -> instantaneous $20. EWMA: 10 + 0.2*(20-10)=12.
        // weekly: drain $5 at 10% util -> instantaneous $50. EWMA: 100 + 0.2*(50-100)=90.
        let next = calibrate(&prev, 2.0, 10.0, 5.0, 10.0);
        assert!((next.quota_5h_usd - 12.0).abs() < 1e-9, "5h EWMA -> 12, got {}", next.quota_5h_usd);
        assert!((next.quota_weekly_usd - 90.0).abs() < 1e-9, "weekly EWMA -> 90, got {}", next.quota_weekly_usd);
        // Moved toward but not all the way to the instantaneous estimate.
        assert!(next.quota_5h_usd > prev.quota_5h_usd && next.quota_5h_usd < 20.0);
    }

    #[test]
    fn calibrate_first_sample_seeds_directly() {
        // prev is zero (Default): the first above-floor sample seeds the EWMA at
        // the instantaneous estimate rather than crawling up from 0.
        let prev = SessionQuota::default();
        let next = calibrate(&prev, 2.0, 10.0, 0.0, 0.0);
        assert!((next.quota_5h_usd - 20.0).abs() < 1e-9, "first sample seeds at instantaneous");
        // weekly stayed below floor (0% util) and prev was 0 -> carries 0.
        assert_eq!(next.quota_weekly_usd, 0.0);
    }
}
