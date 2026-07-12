# /rate-it post-answer flow should recognize design-level suggestions and point at /iterate-it

**Type:** skill-improvement

## Goal

`/rate-it`'s post-rating `AskUserQuestion` always offers the same three options: "Apply all suggestions" / "Apply some, ask me which" / "Ignore, do my thing." That's correct when the "how to raise the score" bullets are mechanical (swap a library, add a config flag). It's the wrong framing when the bullets describe an open architecture/design question that itself needs iterative exploration before any code gets written.

## Context

2026-07-10 session: Joe asked to `/rate-it` an idea (fire scheduled messages when an AUQ gets answered mid-task). Verdict was 4/10 with bullets like "generalize the trigger to session-resumed state" - a design direction, not a concrete patch. Joe picked "Apply all suggestions." The main agent (per the skill's literal instruction: "dev wants the lifts implemented now, main agent proceeds to do them") started grepping the codebase to go straight to implementation. Joe had to interrupt mid-investigation and explicitly invoke `/iterate-it` instead to actually converge the design first. The subsequent 7-round `/iterate-it` proved the redirect was the right call - the design went through 3 more pivots before it was even shippable, and the final round then killed the whole feature on cost/benefit grounds nothing in the original rate-it bullets surfaced.

Related but distinct: `/iterate-it`'s own doc already says "A solo or one-round /rate-it gave a verdict but no clear path forward" is a valid reason to invoke it - so the two skills already know about each other conceptually, they just aren't wired together at the handoff point.

## Approach

In `/rate-it`'s SKILL.md, when "Apply all suggestions" is chosen and the score is mid-range (roughly 3-6/10, i.e. not a slam dunk 7+ nor an irredeemable 1-2) AND the how-to-raise bullets read as architectural/design pivots rather than mechanical swaps, consider either:
- Adding a 4th AskUserQuestion option specifically for this case: "Iterate on the design first (/iterate-it)" alongside the existing three, so the dev doesn't have to know to invoke it manually.
- Or, keep three options but have "Apply all suggestions" itself branch: if the lift bullets are judged design-level, the main agent proposes running `/iterate-it` on the winning bullet instead of writing code directly, and says so before starting.

Don't over-engineer this into a rigid rule - the judgment of "is this bullet mechanical or architectural" is the same kind of call `/rate-it` already makes constantly; it just needs to also drive the post-rating branch, not only the score.

## Acceptance

- Re-running a similar scenario (mid-score /rate-it verdict with an architecture-shaped lift bullet, dev picks "apply all") results in the main agent proposing/using `/iterate-it` before jumping to code, without the dev having to interrupt and say the skill name themselves.
- No change to behavior when the lift bullets are genuinely mechanical (e.g. the Redux example in the skill's own docs) - those should still go straight to "apply now."
