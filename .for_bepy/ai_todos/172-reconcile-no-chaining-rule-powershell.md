# Reconcile the global no-chaining shell rule with PowerShell multi-statement reality

**Type:** skill-improvement

## Goal
Resolve the standing contradiction between the global CLAUDE.md rule "Never chain commands with `&&`, `;`, or `|` - one command per call" and how sessions actually work: PowerShell one-liners (read token + call API + format output) genuinely need `;` and `|`, and the 2026-07-08 session used them in nearly every PowerShell call without harm or pushback.

## Context
The rule (global `~/.claude/CLAUDE.md`, "Shell Commands" section) appears intended to keep git operations atomic/auditable and avoid MSYS/quoting hazards - but as written it bans ALL chaining in ALL shells, which no session honors for PowerShell data-plumbing (e.g. supervisor API calls: `$token = Get-Content ...; Invoke-RestMethod ... | ConvertTo-Json`). A rule that is systematically violated protects nothing and trains rule-skipping.

## Approach
Ask Joe which intent to encode, then edit global CLAUDE.md accordingly. Likely shape: keep "one command per call, no `&&`/`;`" strictly for GIT and other state-changing commands (each mutation its own call), while explicitly allowing `;` / `|` inside a single PowerShell call for read-only plumbing (variable prep, API call, formatting). Whatever Joe picks, the written rule should match enforced practice.

## Acceptance
- Global CLAUDE.md "Shell Commands" section states a rule that sessions can and do follow 100% of the time.
- Joe signed off on the chosen wording.
