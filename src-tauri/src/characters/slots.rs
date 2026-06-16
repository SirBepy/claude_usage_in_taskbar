//! Slot taxonomy + random pick helper.

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum Slot {
    WorkFinished,
    QuestionAsked,
    Ready,
    Select,
    Annoyed,
    Death,
}

impl Slot {
    pub fn all() -> &'static [Slot] {
        &[
            Slot::WorkFinished,
            Slot::QuestionAsked,
            Slot::Ready,
            Slot::Select,
            Slot::Annoyed,
            Slot::Death,
        ]
    }

    pub fn key(self) -> &'static str {
        match self {
            Slot::WorkFinished  => "work_finished",
            Slot::QuestionAsked => "question_asked",
            Slot::Ready         => "ready",
            Slot::Select        => "select",
            Slot::Annoyed       => "annoyed",
            Slot::Death         => "death",
        }
    }

    /// camelCase key used in settings (`characterSoundSlots.<key>`), matching the
    /// frontend's JS naming for the per-slot enable toggles.
    pub fn camel_key(self) -> &'static str {
        match self {
            Slot::WorkFinished  => "workFinished",
            Slot::QuestionAsked => "questionAsked",
            Slot::Ready         => "ready",
            Slot::Select        => "select",
            Slot::Annoyed       => "annoyed",
            Slot::Death         => "death",
        }
    }
}

/// Returns a random entry from the slice or `None` when empty.
/// Single-element slice always returns that element.
pub fn random_pick<'a>(files: &'a [String]) -> Option<&'a String> {
    use rand::seq::SliceRandom;
    files.choose(&mut rand::thread_rng())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slot_key_round_trips() {
        for &s in Slot::all() {
            let json = serde_json::to_string(&s).unwrap();
            assert_eq!(json.trim_matches('"'), s.key());
            let back: Slot = serde_json::from_str(&json).unwrap();
            assert_eq!(back, s);
        }
    }

    #[test]
    fn random_pick_returns_none_for_empty() {
        let v: Vec<String> = vec![];
        assert!(random_pick(&v).is_none());
    }

    #[test]
    fn random_pick_returns_only_element_for_single() {
        let v = vec!["a.wav".to_string()];
        assert_eq!(random_pick(&v).map(String::as_str), Some("a.wav"));
    }

    #[test]
    fn random_pick_returns_some_member_for_multi() {
        let v = vec!["a.wav".to_string(), "b.wav".to_string(), "c.wav".to_string()];
        for _ in 0..20 {
            let pick = random_pick(&v).unwrap();
            assert!(v.contains(pick));
        }
    }

    #[test]
    fn slot_all_has_six_entries() {
        assert_eq!(Slot::all().len(), 6);
    }
}
