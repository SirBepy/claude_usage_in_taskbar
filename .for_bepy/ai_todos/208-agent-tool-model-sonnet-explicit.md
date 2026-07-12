# Enforce explicit model:'sonnet' on every Agent tool dispatch

**Type:** skill-improvement

## Goal

Every subagent dispatch via the `Agent` tool must pass `model: 'sonnet'` explicitly, per the global CLAUDE.md rule ("Every subagent dispatch passes model: 'sonnet' explicitly. Never default-inherit the session model."). This session (2026-07-10, the /iterate-it AUQ-scheduled-message design review) dispatched 7 Agent calls across 4 explore + 3 polish rounds and omitted the `model` param on every single one, relying on inheritance instead.

## Context

No cost harm occurred this time because the session's own model was already Sonnet 5 (inherited == mandatory value by coincidence). But per the CLAUDE.md note, this is exactly the class of mistake that caused the 2026-07-08 incident where an 8-way fan-out + verifiers all inherited Fable 5 and burned a large chunk of tokens. The rule is meant to be followed regardless of what the session happens to be running, precisely so a future session started on Opus/Fable doesn't silently multiply cost across a fan-out.

This isn't a one-off typo - it was missed consistently across 7 separate dispatches in a row within a single session, suggesting the habit isn't reliably triggering when using the plain `Agent` tool (as opposed to `Workflow`'s `agent()` helper, which has its own model-inheritance guidance baked into its tool description).

## Approach

There's no dedicated "orchestration" skill file for solo `Agent` tool dispatches the way `/iterate-it` or `Workflow` have inline docs - the rule lives only in global CLAUDE.md. Options to consider:
- Add a one-line reminder inside skills that dispatch subagents heavily (`/iterate-it`, `/rate-it` panel mode, `/autopilot`, etc.) restating "pass model: 'sonnet' explicitly on every Agent call" directly in their subagent-prompt-template sections, so it's harder to miss mid-skill-execution.
- Alternatively/additionally, check if a PreToolUse hook could warn (not block) when an `Agent` tool call is missing the `model` field, similar to the existing gh-account-switch hook pattern.

## Acceptance

- `/iterate-it`'s SKILL.md subagent prompt template section explicitly reminds the orchestrator to pass `model: 'sonnet'` on the `Agent` call itself (not just in the prompt text), OR a hook-based warning exists and was tested to fire on a missing `model` param.
- No behavior change needed to already-correct skills; verify by grepping `~/.claude/skills/*/SKILL.md` for other heavy-fan-out skills missing the same reminder.
