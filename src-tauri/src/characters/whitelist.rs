//! Whitelist resolution and random pick for character assignment.
//!
//! Both public functions are pure over injected data — no disk access, no
//! cache calls — so they are unit-testable without touching the character
//! loader or the file system.

use std::collections::HashSet;

use crate::characters::Character;
use crate::types::CharacterWhitelist;

/// Resolve a whitelist spec to a sorted, deduped list of character ids.
///
/// * `spec` is the per-project (or per-call) specification.
/// * `default_spec` is the settings-level default, used when `spec` is
///   [`CharacterWhitelist::Default`].
/// * `all` is the full character catalogue (typically from the in-memory
///   cache).
///
/// Fallback: if the resolved set would be empty, it expands to **all
/// non-shared** characters. If `all` is completely empty the return value
/// is an empty `Vec`.
pub fn resolve(
    spec: &CharacterWhitelist,
    default_spec: &CharacterWhitelist,
    all: &[Character],
) -> Vec<String> {
    // Determine the effective spec, collapsing Default -> default_spec ->
    // treat as All if both are Default.
    let effective = match spec {
        CharacterWhitelist::Default => match default_spec {
            CharacterWhitelist::Default => &CharacterWhitelist::All,
            other => other,
        },
        other => other,
    };

    let mut ids: Vec<String> = match effective {
        CharacterWhitelist::Default => {
            // Can only be reached if both spec and default_spec were Default,
            // which the match above already maps to All. Unreachable in
            // practice, but handle defensively.
            all.iter()
                .filter(|c| !c.shared)
                .map(|c| c.id.clone())
                .collect()
        }
        CharacterWhitelist::All => all
            .iter()
            .filter(|c| !c.shared)
            .map(|c| c.id.clone())
            .collect(),
        CharacterWhitelist::Custom { games, ids } => {
            let game_set: HashSet<&str> = games.iter().map(|g| g.as_str()).collect();
            let id_set: HashSet<&str> = ids.iter().map(|i| i.as_str()).collect();

            all.iter()
                .filter(|c| {
                    if c.shared {
                        return false;
                    }
                    // Include if the character's game slug is in the games list.
                    let by_game = c
                        .game
                        .as_deref()
                        .map(|g| game_set.contains(g))
                        .unwrap_or(false);
                    // Include if the character's id is in the explicit ids list.
                    let by_id = id_set.contains(c.id.as_str());
                    by_game || by_id
                })
                .map(|c| c.id.clone())
                .collect()
        }
    };

    ids.sort();
    ids.dedup();

    // Fallback: if the resolved set is empty but there are characters, use all
    // non-shared ones.
    if ids.is_empty() && !all.is_empty() {
        ids = all
            .iter()
            .filter(|c| !c.shared)
            .map(|c| c.id.clone())
            .collect();
        ids.sort();
        ids.dedup();
    }

    ids
}

/// Pick one id at random from `resolved`, preferring ids not in `live_taken`.
///
/// * If some ids are free (not in `live_taken`), picks uniformly from those.
/// * If every id is already taken, allows a duplicate (picks from the full
///   `resolved` set).
/// * Returns `None` only when `resolved` is empty.
pub fn pick_random(resolved: &[String], live_taken: &HashSet<String>) -> Option<String> {
    if resolved.is_empty() {
        return None;
    }

    use rand::seq::SliceRandom;
    let mut rng = rand::thread_rng();

    let free: Vec<&String> = resolved
        .iter()
        .filter(|id| !live_taken.contains(*id))
        .collect();

    if !free.is_empty() {
        free.choose(&mut rng).map(|s| (*s).clone())
    } else {
        resolved.choose(&mut rng).cloned()
    }
}

/// Same selection rules as `pick_random` (prefer a free id, else allow a
/// duplicate, `None` only when `resolved` is empty), but the pick is seeded by
/// `seed` (a session_id) instead of the OS RNG - the SAME session always
/// resolves to the SAME character, regardless of which process/daemon
/// discovers it first. Use this for first-assignment paths (a session should
/// look the same everywhere); `pick_random` remains correct for an explicit
/// user-triggered reroll, which must be able to produce something different.
pub fn pick_deterministic(resolved: &[String], live_taken: &HashSet<String>, seed: &str) -> Option<String> {
    if resolved.is_empty() {
        return None;
    }

    // FNV-1a: simple and deterministic across platforms/compilers/runs, unlike
    // std's DefaultHasher (SipHash), which makes no such cross-build guarantee.
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in seed.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    let idx = hash as usize;

    let free: Vec<&String> = resolved
        .iter()
        .filter(|id| !live_taken.contains(*id))
        .collect();

    if !free.is_empty() {
        Some(free[idx % free.len()].clone())
    } else {
        Some(resolved[idx % resolved.len()].clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::path::PathBuf;

    /// Build a minimal Character for testing. Fields not relevant to whitelist
    /// resolution are filled with cheap defaults.
    fn ch(id: &str, game: Option<&str>, shared: bool) -> Character {
        Character {
            id: id.to_string(),
            label: id.to_string(),
            version: 1,
            icon: String::new(),
            game: game.map(|g| g.to_string()),
            game_label: None,
            shared,
            dir: PathBuf::new(),
            slots: HashMap::new(),
        }
    }

    // ------------------------------------------------------------------
    // resolve
    // ------------------------------------------------------------------

    #[test]
    fn all_returns_only_non_shared() {
        let all = vec![
            ch("peon", Some("warcraft3"), false),
            ch("footman", Some("warcraft3"), false),
            ch("_narrator", None, true),
        ];
        let result = resolve(&CharacterWhitelist::All, &CharacterWhitelist::Default, &all);
        assert_eq!(result, vec!["footman", "peon"]);
    }

    #[test]
    fn custom_by_game_returns_only_that_game() {
        let all = vec![
            ch("peon", Some("warcraft3"), false),
            ch("footman", Some("warcraft3"), false),
            ch("tyrael", Some("diablo"), false),
        ];
        let spec = CharacterWhitelist::Custom {
            games: vec!["warcraft3".into()],
            ids: vec![],
        };
        let result = resolve(&spec, &CharacterWhitelist::Default, &all);
        assert_eq!(result, vec!["footman", "peon"]);
    }

    #[test]
    fn custom_by_ids_drops_nonexistent() {
        let all = vec![
            ch("peon", Some("warcraft3"), false),
            ch("footman", Some("warcraft3"), false),
        ];
        let spec = CharacterWhitelist::Custom {
            games: vec![],
            ids: vec!["peon".into(), "ghost".into()], // ghost does not exist
        };
        let result = resolve(&spec, &CharacterWhitelist::Default, &all);
        assert_eq!(result, vec!["peon"]);
    }

    #[test]
    fn custom_games_and_ids_unions_and_dedups() {
        let all = vec![
            ch("peon", Some("warcraft3"), false),
            ch("footman", Some("warcraft3"), false),
            ch("tyrael", Some("diablo"), false),
        ];
        let spec = CharacterWhitelist::Custom {
            games: vec!["warcraft3".into()],
            ids: vec!["peon".into(), "tyrael".into()], // peon duplicated via game
        };
        let result = resolve(&spec, &CharacterWhitelist::Default, &all);
        assert_eq!(result, vec!["footman", "peon", "tyrael"]);
    }

    #[test]
    fn default_delegates_to_default_spec() {
        let all = vec![
            ch("peon", Some("warcraft3"), false),
            ch("tyrael", Some("diablo"), false),
        ];
        let default_spec = CharacterWhitelist::Custom {
            games: vec!["diablo".into()],
            ids: vec![],
        };
        let result = resolve(&CharacterWhitelist::Default, &default_spec, &all);
        assert_eq!(result, vec!["tyrael"]);
    }

    #[test]
    fn empty_custom_falls_back_to_all() {
        let all = vec![
            ch("peon", Some("warcraft3"), false),
            ch("footman", Some("warcraft3"), false),
        ];
        let spec = CharacterWhitelist::Custom {
            games: vec!["nonexistent-game".into()],
            ids: vec!["ghost".into()],
        };
        let result = resolve(&spec, &CharacterWhitelist::Default, &all);
        // Fallback: all non-shared
        assert_eq!(result, vec!["footman", "peon"]);
    }

    #[test]
    fn default_with_default_default_falls_back_to_all() {
        let all = vec![
            ch("peon", Some("warcraft3"), false),
            ch("footman", Some("warcraft3"), false),
            ch("_shared", None, true),
        ];
        let result = resolve(
            &CharacterWhitelist::Default,
            &CharacterWhitelist::Default,
            &all,
        );
        assert_eq!(result, vec!["footman", "peon"]);
    }

    #[test]
    fn truly_empty_all_returns_empty() {
        let result = resolve(
            &CharacterWhitelist::All,
            &CharacterWhitelist::Default,
            &[],
        );
        assert!(result.is_empty());
    }

    // ------------------------------------------------------------------
    // pick_random
    // ------------------------------------------------------------------

    #[test]
    fn pick_random_empty_returns_none() {
        let taken: HashSet<String> = HashSet::new();
        assert_eq!(pick_random(&[], &taken), None);
    }

    #[test]
    fn pick_random_result_is_always_a_member_of_resolved() {
        let resolved: Vec<String> = vec!["a".into(), "b".into(), "c".into()];
        let taken: HashSet<String> = HashSet::new();
        for _ in 0..50 {
            let pick = pick_random(&resolved, &taken).unwrap();
            assert!(resolved.contains(&pick), "pick {pick} not in resolved");
        }
    }

    #[test]
    fn pick_random_never_takes_taken_when_free_exist() {
        let resolved: Vec<String> = vec!["a".into(), "b".into(), "c".into()];
        let taken: HashSet<String> = ["a".to_string(), "b".to_string()].into();
        // "c" is the only free one; every pick must be "c".
        for _ in 0..50 {
            let pick = pick_random(&resolved, &taken).unwrap();
            assert_eq!(pick, "c", "should only pick free id");
        }
    }

    #[test]
    fn pick_random_when_all_taken_still_returns_some() {
        let resolved: Vec<String> = vec!["a".into(), "b".into()];
        let taken: HashSet<String> = ["a".to_string(), "b".to_string()].into();
        for _ in 0..20 {
            let pick = pick_random(&resolved, &taken);
            assert!(pick.is_some(), "should return Some even when all taken");
            assert!(resolved.contains(pick.as_ref().unwrap()));
        }
    }

    // ------------------------------------------------------------------
    // pick_deterministic
    // ------------------------------------------------------------------

    #[test]
    fn pick_deterministic_empty_returns_none() {
        let taken: HashSet<String> = HashSet::new();
        assert_eq!(pick_deterministic(&[], &taken, "session-1"), None);
    }

    #[test]
    fn pick_deterministic_same_seed_always_same_result() {
        let resolved: Vec<String> = vec!["a".into(), "b".into(), "c".into(), "d".into()];
        let taken: HashSet<String> = HashSet::new();
        let first = pick_deterministic(&resolved, &taken, "session-abc-123");
        for _ in 0..50 {
            assert_eq!(pick_deterministic(&resolved, &taken, "session-abc-123"), first);
        }
    }

    #[test]
    fn pick_deterministic_never_takes_taken_when_free_exist() {
        let resolved: Vec<String> = vec!["a".into(), "b".into(), "c".into()];
        let taken: HashSet<String> = ["a".to_string(), "b".to_string()].into();
        for seed in ["s1", "s2", "s3", "s4"] {
            let pick = pick_deterministic(&resolved, &taken, seed).unwrap();
            assert_eq!(pick, "c", "should only pick free id");
        }
    }

    #[test]
    fn pick_deterministic_when_all_taken_still_returns_some() {
        let resolved: Vec<String> = vec!["a".into(), "b".into()];
        let taken: HashSet<String> = ["a".to_string(), "b".to_string()].into();
        let pick = pick_deterministic(&resolved, &taken, "session-x");
        assert!(pick.is_some(), "should return Some even when all taken");
        assert!(resolved.contains(pick.as_ref().unwrap()));
    }
}
