# App-detected "waiting" state (auto, beyond the Claude-declared marker)

## Goal
Layer automatic detection of the "waiting" session state on top of the Claude-declared marker shipped in commit 829f64b, so a session shows the indigo hourglass even when Claude does NOT remember to emit `<cc-status:waiting>` but is provably parked on a still-running external process.

## Context
Slice 1 (commit 829f64b) added "waiting" as a third turn-status value, DECLARED by Claude via the `<cc-status:waiting>` marker (rides the same rail as done/question - see memory project_turn_status_marker). That covers the case Joe picked: Claude finished its turn having handed off to CI / a long command and yields. Weakness: it depends on the model remembering to emit the marker.

During the 2026-06-18 design chat, app-DETECTION was explicitly deferred as a possible later layer: the app/daemon could infer "waiting" from a still-running background task (e.g. a `run_in_background` bash command the harness tracks) or a foreground command that has been in flight past a threshold, without relying on the self-report. The daemon does not inherently know "this background process is CI", but it does know a tracked background command is still running.

## Approach
- Find where the daemon tracks in-flight / background tool executions per session (background bash tasks, long-running commands).
- When a session has a tracked external process still running AND its turn has ended (not busy), surface `awaiting = "waiting"` from the backend even if no marker was emitted. Keep it additive: a real `<cc-status:waiting>` marker still wins; this only fills the gap when the marker is absent.
- Clear it when the tracked process completes or the next user turn starts (same lifecycle point as the declared waiting).
- Do NOT regress the declared path or the done/question states; this is purely a fallback source feeding the same `i.awaiting === "waiting"` the sidebar already reads.

## Acceptance
- A session whose turn ended with a tracked background/long command still running shows the indigo hourglass without Claude having emitted the marker.
- The declared marker path is unchanged; busy still outranks waiting.
- `cargo build --manifest-path src-tauri/Cargo.toml` clean; scoped parser/daemon tests green (never the full `--lib`).
