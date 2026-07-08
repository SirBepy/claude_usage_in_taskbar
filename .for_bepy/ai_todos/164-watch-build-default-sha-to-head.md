# watch-build.ps1 should resolve HEAD itself instead of trusting a passed sha

**Type:** skill-improvement

## Goal
Make the /commit skill's CI build watcher immune to a wrong hand-typed sha.

## Context
During the 2026-07-07 release, the main agent launched `~/.claude/skills/commit/watch-build.ps1` with a fabricated full sha (typed the short sha's tail from memory instead of running rev-parse), and the watcher had to be killed and relaunched. The SKILL.md instruction ("get the pushed sha via git rev-parse HEAD") existed but was skippable - an enforcement gap, not a care gap.

## Approach
In `C:\Users\tecno\.claude\skills\commit\watch-build.ps1`: make `-Sha` optional; when omitted (or when the value is shorter than 40 hex chars / fails a format check), resolve it inside the script via `git rev-parse HEAD` on `-RepoPath` (add the param, default to the current directory). Update the SKILL.md build-watch step to launch the watcher WITHOUT a sha argument by default.

## Acceptance
Launching `watch-build.ps1 -Branch master` with no sha watches the correct HEAD sha's runs; passing a malformed sha is corrected or rejected loudly instead of silently watching nothing.
