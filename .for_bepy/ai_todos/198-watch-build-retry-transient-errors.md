# watch-build.ps1 declares failure on transient gh errors while the run is still in progress

**Type:** skill-improvement

## Goal
The commit skill's CI watcher should retry transient gh API errors instead of emitting `BUILD_RESULT=failure` for a run that is still in progress.

## Context
Observed 2026-07-09 in claude_usage_in_taskbar: `~/.claude/skills/commit/watch-build.ps1` polled jobs, got `HTTP 401: Bad credentials` (transient - plausibly a concurrent session's gh account switch via the global PreToolUse hook flipping gh's active account mid-poll; unverified), and immediately printed `BUILD_RESULT=failure FAILED=1/` plus "run ... is still in progress; logs will be available when it is complete". The run was in fact still running and had not failed. The main agent had to detect the contradiction manually and relaunch the watcher.

## Approach
Edit `C:\Users\tecno\.claude\skills\commit\watch-build.ps1`:
- Treat gh exit-nonzero / HTTP 4xx-5xx on the polling calls as transient: retry with backoff (e.g. 3 attempts over ~2 min) before concluding anything.
- Only emit `BUILD_RESULT=failure` when the API positively reports a completed run with conclusion failure; if status is still in_progress after retries, keep polling.
- Optionally emit a distinct `BUILD_RESULT=watch_error` for persistent API errors so the agent knows to relaunch rather than diagnose a build.
Also update the /commit SKILL.md build-watch section to document the new marker if added.

## Acceptance
Simulated 401 (or revoked-token dry run) during an in-progress run does not produce BUILD_RESULT=failure; a genuinely red run still does; a green run still emits success.
