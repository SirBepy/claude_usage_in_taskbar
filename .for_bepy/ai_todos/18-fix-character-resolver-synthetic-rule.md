# Fix failing character-resolver notification-rule test

## Goal

Make `resolve_with_character` return the synthetic CHARACTER sound-pack rule when a valid character with a matching slot file is active, instead of falling back to the `"default"` pack. The Rust unit test `notifications::rules::tests::character_resolver_returns_synthetic_rule_for_valid_character_with_slot_file` must pass.

## Context

- Found while running `cargo test` during the unified-component-look **Phase 2** frontend work (2026-06-01). Phase 2 touched **zero Rust** — this failure is pre-existing / unrelated to it. At the time the repo had uncommitted character/notifications WIP, so this may be a half-finished feature on Joe's end (confirm before "fixing").
- Failure: `src-tauri/src/notifications/rules.rs:302`
  ```
  assert_eq!(rule.sound_pack, CHARACTER_PACK_SENTINEL);
  left:  "default"
  right: "__character__"
  ```
- Suite result: `339 passed; 1 failed`. Only this test fails.
- The test (`rules.rs` ~280-314): injects a `Character { id: "happy-peon", slots: {work_finished: ["sounds/done.wav"]}, dir: /fake/chars/happy-peon }` into the character cache via `characters::cache::set_for_test`, sets a project key for `C:/proj`, then calls `resolve_with_character(&cfg, &s, NotifKind::WorkFinished, Some(&key))` and expects a rule with `sound_pack == CHARACTER_PACK_SENTINEL` ("__character__"), `mode == Sound`, `enabled`, and `sound_file` = the character `dir` joined with the slot file (contains "happy-peon", ends with "done.wav").

## Approach

1. Read `resolve_with_character` in `src-tauri/src/notifications/rules.rs`. Trace why, with a cached character that has a `work_finished` slot, it returns `sound_pack = "default"` rather than emitting the synthetic character rule.
2. Likely suspects: (a) the resolver isn't consulting the character cache / the per-project character selection for the given `project_key`; (b) the slot lookup for `NotifKind::WorkFinished` → `"work_finished"` key mismatch; (c) the synthetic-rule branch is gated on a condition that regressed (recent character/notifications WIP).
3. FIRST decide whether the TEST or the CODE is the source of truth — if Joe's WIP intentionally changed the resolver's contract, the test may need updating instead. Check git history / Joe's intent before changing behavior.
4. Fix the resolver (or the test, per step 3) so the character pack is resolved when a valid character + slot file is present.

## Acceptance

- `cargo test --manifest-path src-tauri/Cargo.toml` → `340 passed; 0 failed` (the one test goes green).
- No regression in the other `notifications::rules` tests (there are several around the same module).
- The character sound-pack actually plays the character's slot sound in the real app for a project with a character assigned (manual check if touching resolver behavior).
