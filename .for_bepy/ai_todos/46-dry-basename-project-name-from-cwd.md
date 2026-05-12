# Reuse project_name_from_cwd in skill_usage parser

## Goal
Drop the local `basename` helper in `skill_usage/parser.rs` and use the existing `notifications::rules::project_name_from_cwd`.

## Context
`src-tauri/src/skill_usage/parser.rs:297-303` defines:

```rust
fn basename(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    trimmed.rsplit(|c| c == '/' || c == '\\').next().unwrap_or(trimmed).to_string()
}
```

`src-tauri/src/notifications/rules.rs:107-110` already has:

```rust
pub fn project_name_from_cwd(cwd: &str) -> Option<String> {
    let last = cwd.rsplit(|c| c == '/' || c == '\\').next()?.to_string();
    if last.is_empty() { None } else { Some(last) }
}
```

They differ in: trailing-slash handling (parser trims, rules doesn't), and the return type (`String` vs `Option<String>`). Trailing-slash difference is irrelevant for skill_usage's inputs (Claude Code cwd payload never has a trailing slash). The Option just means the caller does `.unwrap_or_default()`.

## Approach
1. In `parser.rs`, replace the call `cwd.as_deref().map(basename).unwrap_or_default()` with `cwd.as_deref().and_then(crate::notifications::project_name_from_cwd).unwrap_or_default()`. The hooks/server.rs at line 82 already uses this pattern verbatim — copy it.
2. Delete the local `basename` function.
3. Run the skill_usage tests: `cargo test --manifest-path src-tauri/Cargo.toml --test skill_usage_parser` — all 7 should still pass.

## Acceptance
`grep -n "fn basename" src-tauri/src/skill_usage/parser.rs` returns nothing. Tests still pass. The "project" field on emitted `SkillUsageEvent`s is unchanged for normal cwd inputs.
