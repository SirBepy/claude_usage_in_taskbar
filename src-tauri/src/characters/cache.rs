//! In-memory cache for the character list.
//!
//! `characters::list()` walks `<app-data>/characters/` from disk on every
//! call: read_dir + per-character JSON parse + per-slot file `.exists()`.
//! This is fine for one-off IPC calls but adds up when the notification
//! resolver hits it once per `WorkFinished`/`QuestionAsked` notification.
//!
//! This module wraps `list()` behind a process-wide cache. The cache is
//! invalidated explicitly via [`invalidate`], which the frontend triggers
//! through the `invalidate_characters_cache` IPC after the user clicks
//! Refresh in the Characters view (or after `/character-creator` writes a
//! new bundle on disk).
//!
//! No filesystem watcher: deliberate trade-off; see
//! `.for_bepy/ai_todos/03-cache-character-list.md`.

use std::sync::{Mutex, OnceLock};

use crate::characters::Character;

/// Process-wide cache of the loaded character list. `None` = empty / never
/// populated; `Some(vec)` = last load result. Wrapped in a Mutex so reload
/// is exclusive (multiple concurrent readers will wait for a single load
/// rather than racing to disk).
fn cell() -> &'static Mutex<Option<Vec<Character>>> {
    static CELL: OnceLock<Mutex<Option<Vec<Character>>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

/// Returns the cached character list, loading from disk on first call or
/// after [`invalidate`]. Hot path for the notification resolver.
pub fn cached_list() -> Vec<Character> {
    let mut guard = cell().lock().unwrap();
    if let Some(list) = guard.as_ref() {
        return list.clone();
    }
    let fresh = load_from_disk();
    *guard = Some(fresh.clone());
    fresh
}

/// Drops the cached list. Next [`cached_list`] call will re-scan disk.
pub fn invalidate() {
    *cell().lock().unwrap() = None;
}

/// Replaces the cache contents with the supplied list. Test-only injection
/// hook for `notifications::rules::resolve_with_character` happy-path
/// coverage; production code should use [`invalidate`] + [`cached_list`].
#[cfg(test)]
pub fn set_for_test(list: Vec<Character>) {
    *cell().lock().unwrap() = Some(list);
}

fn load_from_disk() -> Vec<Character> {
    let Ok(dir) = crate::settings::paths::characters_dir() else { return vec![]; };
    crate::characters::loader::load_all(&dir)
}

#[cfg(test)]
pub(crate) fn fake_character_for_test(id: &str) -> Character {
    use std::collections::HashMap;
    use std::path::PathBuf;
    Character {
        id: id.into(),
        label: id.into(),
        version: 1,
        icon: "icon.png".into(),
        game: None,
        game_label: None,
        shared: false,
        dir: PathBuf::new(),
        slots: HashMap::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Serialize cache-touching tests so cargo's parallel runner can't race
    // on the single global slot.
    fn test_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
        LOCK.get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn cached_list_returns_seeded_value() {
        let _g = test_lock();
        invalidate();
        set_for_test(vec![fake_character_for_test("beta")]);
        let a = cached_list();
        let b = cached_list();
        assert_eq!(a, b);
        assert_eq!(b[0].id, "beta");
        invalidate();
    }

    #[test]
    fn invalidate_drops_seeded_entry() {
        let _g = test_lock();
        invalidate();
        set_for_test(vec![fake_character_for_test("alpha")]);
        let first = cached_list();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].id, "alpha");

        invalidate();
        // After invalidate the cache is None; cached_list will hit
        // load_from_disk(). In test there's no app-data characters dir,
        // so this returns an empty vec. The point: the seeded "alpha"
        // entry is gone, proving invalidate() actually cleared the slot.
        let second = cached_list();
        assert!(
            second.iter().all(|c| c.id != "alpha"),
            "expected invalidate to drop the seeded entry; got {second:?}"
        );
        invalidate();
    }
}
