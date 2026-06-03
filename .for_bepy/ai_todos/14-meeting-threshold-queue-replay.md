# Optional: queue-and-replay threshold pings suppressed during a meeting

## Goal

Decide whether a `ThresholdCrossed` notification that would fire WHILE a meeting is active should be replayed once the meeting ends, instead of being silently dropped.

## Context

Shipped in commit 61eddc9 (meeting-mode notification pause). `notifications::rules::fire` drops ALL pings (work-finished / question-asked / threshold-crossed) while `AppState.meeting_active` is true and `pauseInMeeting` is on. Threshold crossings fire on the crossing EDGE, so a threshold reached mid-meeting is dropped and never re-fires after the call ends - Joe could miss that he crossed 80%. Work-finished/question pings are inherently transient and fine to drop; only the threshold one has lasting signal worth replaying.

This is a deliberate design question, not a bug - current behavior is "true stop notifications," which is defensible. Only build if Joe wants the replay.

## Approach

On entering a meeting, if a threshold is crossed while suppressed, remember the highest suppressed threshold per scope (session / weekly). When `meeting_active` flips back to false (the watcher transition in `meeting/mod.rs`, or a check in the next `fire`), re-fire the threshold ping once if the threshold is still crossed. Keep work-finished/question drops as-is (no replay). Guard against replaying a threshold the user already saw before the meeting.

## Acceptance

- Cross a usage threshold during a meeting: no ping mid-call.
- End the meeting with the threshold still crossed: exactly one threshold ping fires.
- Work-finished / question pings during the meeting are still dropped, not replayed.
- Toggling `pauseInMeeting` off restores immediate threshold pings.
