//! Pure recurrence date-math for scheduled items: given the last fire instant
//! and a `Recurrence` rule, compute the next one. No dependency on the
//! `scheduled_items` file store - split out purely because it's an obvious,
//! already-independent module boundary (see ai_todo 215).

use super::scheduled_items::{Recurrence, RecurrenceRule};
use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, TimeZone, Utc};

/// Computes the next local-time occurrence strictly after `after`, per
/// `recurrence`, returned in UTC (storage format). Pure and infallible: an
/// unparsable `recurrence.time` falls back to 00:00, and a DST gap/ambiguity
/// around the target local time resolves via `local_at`'s fallback rather
/// than panicking.
pub fn next_occurrence(after: DateTime<Utc>, recurrence: &Recurrence) -> DateTime<Utc> {
    let after_local = after.with_timezone(&Local);
    let (hour, minute) = parse_hhmm(&recurrence.time).unwrap_or((0, 0));

    let candidate_local = match &recurrence.rule {
        RecurrenceRule::Daily => next_daily(after_local, hour, minute),
        RecurrenceRule::Weekly { weekdays } => next_weekly(after_local, hour, minute, weekdays),
        RecurrenceRule::EveryNDays { n } => next_every_n_days(after_local, hour, minute, *n),
    };
    candidate_local.with_timezone(&Utc)
}

fn parse_hhmm(s: &str) -> Option<(u32, u32)> {
    let (h, m) = s.split_once(':')?;
    let h: u32 = h.trim().parse().ok()?;
    let m: u32 = m.trim().parse().ok()?;
    if h > 23 || m > 59 {
        return None;
    }
    Some((h, m))
}

/// Resolves `date` at `hour:minute` in the local timezone, robust to DST:
/// ambiguous (fall-back, two valid instants) picks the earliest; a
/// nonexistent time (spring-forward gap) returns `None` instead of
/// panicking, letting callers fall back to a plain-duration bump.
fn local_at(date: NaiveDate, hour: u32, minute: u32) -> Option<DateTime<Local>> {
    let naive = date.and_hms_opt(hour, minute, 0)?;
    match Local.from_local_datetime(&naive) {
        chrono::LocalResult::Single(dt) => Some(dt),
        chrono::LocalResult::Ambiguous(earliest, _latest) => Some(earliest),
        chrono::LocalResult::None => None,
    }
}

fn next_daily(after: DateTime<Local>, hour: u32, minute: u32) -> DateTime<Local> {
    if let Some(today) = local_at(after.date_naive(), hour, minute) {
        if today > after {
            return today;
        }
    }
    let tomorrow = after.date_naive().succ_opt().unwrap_or(after.date_naive());
    local_at(tomorrow, hour, minute).unwrap_or(after + Duration::days(1))
}

fn next_weekly(after: DateTime<Local>, hour: u32, minute: u32, weekdays: &[u8]) -> DateTime<Local> {
    if weekdays.is_empty() {
        // Defensive: an empty weekday set is a malformed recurrence. Fall
        // back to "daily" rather than looping forever with no match.
        return next_daily(after, hour, minute);
    }
    let base_date = after.date_naive();
    // 0..=7: the 7 offset guarantees a match even when today's weekday is
    // the only selected day AND today's time-of-day has already passed -
    // the wraparound to next week is always > `after` regardless of clock.
    for offset in 0..=7i64 {
        let date = base_date + Duration::days(offset);
        let dow = date.weekday().num_days_from_monday() as u8;
        if !weekdays.contains(&dow) {
            continue;
        }
        if let Some(candidate) = local_at(date, hour, minute) {
            if candidate > after {
                return candidate;
            }
        }
    }
    // Unreachable in practice (the offset=7 same-weekday wrap always
    // qualifies), but never panic: fall back to a week out.
    after + Duration::days(7)
}

fn next_every_n_days(after: DateTime<Local>, hour: u32, minute: u32, n: u32) -> DateTime<Local> {
    let n = n.max(1) as i64;
    if let Some(today) = local_at(after.date_naive(), hour, minute) {
        if today > after {
            return today;
        }
    }
    let next_date = after.date_naive() + Duration::days(n);
    local_at(next_date, hour, minute).unwrap_or(after + Duration::days(n))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Timelike;

    fn utc(y: i32, m: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, m, d, h, mi, 0).unwrap()
    }

    /// Builds the UTC instant for a given LOCAL wall-clock date/time. Tests
    /// that reason about "today" / "tomorrow" / a specific weekday must use
    /// this (not `utc()`) so the test's own local-calendar assumptions hold
    /// no matter which timezone the test runs in - `utc(2026, 7, 9, 23, 0)`
    /// lands on a different local calendar day (even a different weekday)
    /// depending on the runner's offset, which is exactly the bug this
    /// helper avoids.
    fn local_wall(y: i32, m: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
        Local
            .with_ymd_and_hms(y, m, d, h, mi, 0)
            .single()
            .expect("valid unambiguous local wall-clock time")
            .with_timezone(&Utc)
    }

    // --- next_occurrence: Daily ---

    #[test]
    fn daily_before_time_fires_same_day() {
        let rec = Recurrence { time: "09:00".into(), rule: RecurrenceRule::Daily };
        // 2026-07-09 is a Thursday; pick a time well before 09:00 local.
        let after = local_wall(2026, 7, 9, 1, 0);
        let next = next_occurrence(after, &rec);
        let local = next.with_timezone(&Local);
        assert_eq!(local.date_naive(), after.with_timezone(&Local).date_naive());
        assert_eq!((local.hour(), local.minute()), (9, 0));
    }

    #[test]
    fn daily_after_time_rolls_to_tomorrow() {
        let rec = Recurrence { time: "09:00".into(), rule: RecurrenceRule::Daily };
        let after = local_wall(2026, 7, 9, 23, 0);
        let next = next_occurrence(after, &rec);
        assert!(next > after);
        let local = next.with_timezone(&Local);
        let after_local = after.with_timezone(&Local);
        assert_eq!(local.date_naive(), after_local.date_naive().succ_opt().unwrap());
        assert_eq!((local.hour(), local.minute()), (9, 0));
    }

    // --- next_occurrence: Weekly ---

    #[test]
    fn weekly_picks_next_matching_weekday_same_week() {
        // 2026-07-09 is Thursday (dow=3). Ask for Mon/Wed/Fri (0,2,4): next
        // match after Thursday morning is Friday (dow=4).
        let rec = Recurrence {
            time: "09:00".into(),
            rule: RecurrenceRule::Weekly { weekdays: vec![0, 2, 4] },
        };
        let after = local_wall(2026, 7, 9, 1, 0);
        let next = next_occurrence(after, &rec).with_timezone(&Local);
        assert_eq!(next.weekday().num_days_from_monday(), 4);
        assert!(next > after.with_timezone(&Local));
    }

    #[test]
    fn weekly_wraps_to_next_week_when_all_days_passed() {
        // Only Thursday (dow=3) selected, and it's already past 09:00 on
        // Thursday: must wrap to the FOLLOWING Thursday, not stay stuck.
        let rec = Recurrence {
            time: "09:00".into(),
            rule: RecurrenceRule::Weekly { weekdays: vec![3] },
        };
        let after = local_wall(2026, 7, 9, 23, 0); // Thursday 23:00 local
        let next = next_occurrence(after, &rec).with_timezone(&Local);
        let after_local = after.with_timezone(&Local);
        assert_eq!(next.weekday().num_days_from_monday(), 3);
        assert!(next.date_naive() > after_local.date_naive());
        assert!((next.date_naive() - after_local.date_naive()).num_days() >= 6);
    }

    #[test]
    fn weekly_same_day_before_time_fires_today() {
        let rec = Recurrence {
            time: "18:00".into(),
            rule: RecurrenceRule::Weekly { weekdays: vec![3] }, // Thursday
        };
        let after = local_wall(2026, 7, 9, 1, 0); // Thursday early morning
        let next = next_occurrence(after, &rec).with_timezone(&Local);
        let after_local = after.with_timezone(&Local);
        assert_eq!(next.date_naive(), after_local.date_naive());
        assert_eq!((next.hour(), next.minute()), (18, 0));
    }

    // --- next_occurrence: EveryNDays ---

    #[test]
    fn every_n_days_steps_forward_by_n_when_today_passed() {
        let rec = Recurrence { time: "09:00".into(), rule: RecurrenceRule::EveryNDays { n: 3 } };
        let after = local_wall(2026, 7, 9, 23, 0);
        let next = next_occurrence(after, &rec).with_timezone(&Local);
        let after_local = after.with_timezone(&Local);
        assert_eq!((next.date_naive() - after_local.date_naive()).num_days(), 3);
        assert_eq!((next.hour(), next.minute()), (9, 0));
    }

    #[test]
    fn every_n_days_fires_today_when_time_not_yet_passed() {
        let rec = Recurrence { time: "23:30".into(), rule: RecurrenceRule::EveryNDays { n: 5 } };
        let after = local_wall(2026, 7, 9, 1, 0);
        let next = next_occurrence(after, &rec).with_timezone(&Local);
        let after_local = after.with_timezone(&Local);
        assert_eq!(next.date_naive(), after_local.date_naive());
    }

    #[test]
    fn every_n_days_zero_is_clamped_to_one() {
        let rec = Recurrence { time: "09:00".into(), rule: RecurrenceRule::EveryNDays { n: 0 } };
        let after = utc(2026, 7, 9, 23, 0);
        let next = next_occurrence(after, &rec);
        assert!(next > after, "n=0 must not stall recurrence forever");
    }

    // --- misc sanity ---

    #[test]
    fn next_occurrence_is_always_strictly_after_input() {
        for rule in [
            RecurrenceRule::Daily,
            RecurrenceRule::Weekly { weekdays: vec![0, 1, 2, 3, 4, 5, 6] },
            RecurrenceRule::EveryNDays { n: 1 },
        ] {
            let rec = Recurrence { time: "00:00".into(), rule };
            let after = utc(2026, 7, 9, 0, 0);
            assert!(next_occurrence(after, &rec) > after, "{rec:?} must produce a strictly-future instant");
        }
    }

    #[test]
    fn unparsable_time_falls_back_to_midnight_without_panicking() {
        let rec = Recurrence { time: "not-a-time".into(), rule: RecurrenceRule::Daily };
        let after = utc(2026, 7, 9, 12, 0);
        let next = next_occurrence(after, &rec).with_timezone(&Local);
        assert_eq!((next.hour(), next.minute()), (0, 0));
    }
}
