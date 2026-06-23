# Dedup the windowed vs lifetime drain functions in tokens/drain.rs

## Goal
Collapse the near-duplicate "lifetime" and "since-cutoff" drain functions into one each, and share the single RFC 3339 -> SystemTime parse, so there's one code path instead of two copies.

## Context
The per-chat token-drain reframe (commit b33939a) added windowed variants that duplicate the existing lifetime ones in `src-tauri/src/tokens/drain.rs`:
- `transcript_drain_units` (lifetime) and `transcript_drain_units_since` (timestamp-filtered) share the same open-file + line-read + `line_drain` summation loop; the only difference is the `_since` version gates each line on `line_timestamp(&v) >= cutoff`.
- `drain_units_for_session` and `drain_units_for_session_since` share the identical main-transcript + `subagents/*.jsonl` walk; only the inner per-file call differs.

Separately, RFC 3339 -> SystemTime is parsed in two places this session: `tokens/drain.rs::line_timestamp` (extracts the `timestamp` json field then parses) and `src-tauri/src/ipc/drain.rs::parse_rfc3339` (parses a bare string). The core "DateTime::parse_from_rfc3339 -> guard secs >= 0 -> UNIX_EPOCH + Duration" is copied in both.

## Approach
- Give the transcript/session drain functions an optional cutoff: `transcript_drain_units(path, since: Option<SystemTime>)` and `drain_units_for_session(cwd, id, since: Option<SystemTime>)`, where `None` counts every line (the old lifetime behavior). Drop the `_since` variants. Update the two call sites in `ipc/drain.rs` (`compute_capacities` passes `Some(start)`, the lifetime numerator passes `None`).
- Extract the bare `rfc3339 &str -> Option<SystemTime>` step into one helper (e.g. `tokens::rfc3339_to_system_time`) and have both `line_timestamp` (after pulling the json field) and `ipc/drain.rs::parse_rfc3339` call it.

## Acceptance
- `cargo build --manifest-path src-tauri/Cargo.toml --lib` is clean.
- `cargo test --lib tokens::` still green (the existing drain tests cover the lifetime path; add one asserting a cutoff excludes earlier-timestamped lines).
- No remaining `_since`-suffixed drain function and only one RFC 3339 -> SystemTime parser in the codebase.
