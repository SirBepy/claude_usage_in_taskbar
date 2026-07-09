# batch-todos should surface a recommendation before the raw HARD-queue menu

**Type:** skill-improvement

## Goal

When `/batch-todos` Step 6 surfaces the HARD queue via AskUserQuestion, it should lead with Claude's own prioritization/urgency read (even briefly) before or alongside the bare option list, not just dump N todo titles with no signal about which matters most.

## Context

During the 2026-07-09 `/batch-todos` run on claude_usage_in_taskbar, Step 6 was followed literally: AskUserQuestion with 4 raw HARD-todo options, no framing. Joe rejected the tool call and asked "what do you recommend? is there anything with high urgency? is anything worth deleting?" - i.e. he wanted judgment before being asked to pick blind. This mirrors the existing memory [[feedback_conclude_before_deferring_to_panel]] (own verdict first, before deferring to a panel/choice) - the correction wasn't a new lesson so much as the skill's literal spec (`batch-todos/SKILL.md` Step 6: "Question: ... Options: one per HARD todo") not leaving room for that verdict.

Fixing it required a whole extra research pass (a dedicated triage subagent reading all 30+ HARD todo bodies, cross-checking git log for staleness, ranking urgency) that could have been front-loaded into the skill's own flow instead of bolted on after a rejection.

## Approach

Edit `C:\Users\tecno\.claude-fibo\skills\batch-todos\SKILL.md` Step 6 (or wherever the HARD-queue surfacing logic lives - re-locate if the skill has moved). Before the AskUserQuestion call, add a step that skims each HARD todo (title + Goal, not full triage) and produces a short urgency read (high/med/low) plus any explicit "stale/delete candidate" flags (todos marked done/shipped/deprioritized by the dev's own prior notes). Feed that into the question framing - either as lead-in prose before the AskUserQuestion call, or by ordering/annotating the shown options by urgency instead of raw id order.

Don't over-engineer this into a full separate triage subagent by default (that's expensive - the 2026-07-09 pass cost a dedicated 100k-token subagent). A lightweight per-file skim (title + Goal only) is enough signal for 90% of cases; only escalate to a deeper triage pass if the dev explicitly asks "what's urgent" the way Joe did here.

## Acceptance

- Step 6's AskUserQuestion call (or the prose immediately preceding it) includes at least a one-line urgency signal per shown option, not just bare titles.
- Behavior for a dev who just wants to pick blind is unchanged - the recommendation is additive framing, never a forced detour or extra confirmation step.
