//! Durable store for scheduled messages / scheduled new-chats.
//!
//! Scheduling fires a stored prompt into an existing chat (`ScheduledKind::
//! Message`) or spawns a brand-new chat (`ScheduledKind::NewChat`) at a future
//! time, once or on a recurrence. The daemon's `daemon::schedule` tick loop
//! owns firing; this module is only the persisted record + the pure
//! recurrence math.
//!
//! File: `<app-data>/scheduled-items.json` -> `{ "<id>": ScheduledItem }`.
//! Sole writer is the daemon (the schedule tick loop + the `schedule_*` RPC
//! methods in `daemon::methods::schedule`); the main app only reads
//! (`schedule_list` IPC command mirrors `get_session_config` / `list_auto_
//! accept` in `ipc/misc.rs`, both of which read this same kind of daemon-
//! owned file directly). Writes are atomic (tmp + rename) so a concurrent
//! reader never sees a torn file.

use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// What a scheduled item does when it fires.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, ts_rs::TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum ScheduledKind {
    /// Send `prompt` into an existing chat. `cwd` is carried alongside
    /// `session_id` because the daemon-internal resume-respawn path (mirrors
    /// the app-side -32004 retry in `ipc/chat/run.rs`) needs a cwd to spawn.
    Message { session_id: String, cwd: String },
    /// Spawn a brand-new chat and send `prompt` as its first turn.
    NewChat {
        cwd: String,
        model: String,
        effort: String,
        account_id: Option<String>,
    },
}

/// A recurrence rule: a local time-of-day plus a repeat pattern.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct Recurrence {
    /// Local "HH:MM" time of day the item recurs at.
    pub time: String,
    pub rule: RecurrenceRule,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, ts_rs::TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum RecurrenceRule {
    Daily,
    /// `weekdays`: 0=Mon..6=Sun (matches `chrono::Weekday::num_days_from_monday`).
    Weekly { weekdays: Vec<u8> },
    EveryNDays { n: u32 },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, ts_rs::TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum ScheduledStatus {
    Pending,
    Sent,
    Failed { reason: String },
    Missed,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct ScheduledItem {
    pub id: String,
    pub kind: ScheduledKind,
    pub prompt: String,
    /// UTC RFC3339, the next (or, for a fired one-shot, the only) fire time.
    pub fire_at: String,
    pub recurrence: Option<Recurrence>,
    pub status: ScheduledStatus,
    pub created_at: String,
    pub last_fired_at: Option<String>,
    pub last_result: Option<String>,
}

impl ScheduledItem {
    /// Builds a fresh Pending item: generates the id (uuid, matching the
    /// codebase's session-id convention in `daemon::lifecycle::spawn_session`)
    /// and `created_at`, leaving `last_fired_at`/`last_result` unset.
    pub fn new(kind: ScheduledKind, prompt: String, fire_at: String, recurrence: Option<Recurrence>) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            kind,
            prompt,
            fire_at,
            recurrence,
            status: ScheduledStatus::Pending,
            created_at: chrono::Utc::now().to_rfc3339(),
            last_fired_at: None,
            last_result: None,
        }
    }
}

/// Serialize read-modify-write within a process. Cross-process integrity comes
/// from the atomic rename, not this lock.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn config_path() -> Option<PathBuf> {
    crate::settings::paths::data_dir().ok().map(|d| d.join("scheduled-items.json"))
}

fn load_map(path: &Path) -> HashMap<String, ScheduledItem> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_atomic(path: &Path, map: &HashMap<String, ScheduledItem>) {
    let json = match serde_json::to_string_pretty(map) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("scheduled-items: serialize failed: {e}");
            return;
        }
    };
    if let Err(e) = crate::util::write_json_atomic(path, &json) {
        log::warn!("scheduled-items: write failed: {e}");
    }
}

/// All scheduled items, in no particular order (the frontend sorts for display).
pub fn list() -> Vec<ScheduledItem> {
    let Some(path) = config_path() else { return Vec::new() };
    list_at(&path)
}

fn list_at(path: &Path) -> Vec<ScheduledItem> {
    load_map(path).into_values().collect()
}

pub fn get(id: &str) -> Option<ScheduledItem> {
    let path = config_path()?;
    get_at(&path, id)
}

fn get_at(path: &Path, id: &str) -> Option<ScheduledItem> {
    load_map(path).get(id).cloned()
}

/// Insert or overwrite an item by id. Used for both create and update -
/// the caller (RPC handler / scheduler tick) always has the full record.
/// Best-effort, never panics; a no-op if `item.id` is empty.
pub fn upsert(item: ScheduledItem) {
    let Some(path) = config_path() else { return };
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    upsert_at(&path, item);
}

fn upsert_at(path: &Path, item: ScheduledItem) {
    if item.id.is_empty() {
        return;
    }
    let mut map = load_map(path);
    map.insert(item.id.clone(), item);
    write_atomic(path, &map);
}

/// Removes an item by id. Returns true if it existed.
pub fn delete(id: &str) -> bool {
    let Some(path) = config_path() else { return false };
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    delete_at(&path, id)
}

fn delete_at(path: &Path, id: &str) -> bool {
    let mut map = load_map(path);
    let existed = map.remove(id).is_some();
    if existed {
        write_atomic(path, &map);
    }
    existed
}

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

    fn item(kind: ScheduledKind) -> ScheduledItem {
        ScheduledItem::new(kind, "hi".into(), "2026-01-01T00:00:00Z".into(), None)
    }

    fn message_kind() -> ScheduledKind {
        ScheduledKind::Message { session_id: "sess-1".into(), cwd: "C:/proj".into() }
    }

    // --- store round-trip ---

    #[test]
    fn round_trips_create_and_get() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("scheduled-items.json");
        let it = item(message_kind());
        let id = it.id.clone();
        upsert_at(&path, it.clone());
        let got = get_at(&path, &id).expect("recorded");
        assert_eq!(got, it);
        assert!(get_at(&path, "missing").is_none());
    }

    #[test]
    fn upsert_overwrites_existing_id() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("scheduled-items.json");
        let mut it = item(message_kind());
        upsert_at(&path, it.clone());
        it.status = ScheduledStatus::Sent;
        upsert_at(&path, it.clone());
        assert_eq!(get_at(&path, &it.id).unwrap().status, ScheduledStatus::Sent);
        assert_eq!(list_at(&path).len(), 1, "overwrite must not duplicate");
    }

    #[test]
    fn delete_removes_and_reports_existence() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("scheduled-items.json");
        let it = item(message_kind());
        upsert_at(&path, it.clone());
        assert!(delete_at(&path, &it.id));
        assert!(get_at(&path, &it.id).is_none());
        assert!(!delete_at(&path, &it.id), "second delete is a no-op false");
    }

    #[test]
    fn empty_id_upsert_is_noop() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("scheduled-items.json");
        let mut it = item(message_kind());
        it.id = String::new();
        upsert_at(&path, it);
        assert!(!path.exists(), "no file written for empty id");
    }

    #[test]
    fn list_returns_all_items() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("scheduled-items.json");
        upsert_at(&path, item(message_kind()));
        upsert_at(&path, item(ScheduledKind::NewChat {
            cwd: "C:/proj2".into(), model: "opus".into(), effort: "high".into(), account_id: None,
        }));
        assert_eq!(list_at(&path).len(), 2);
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
