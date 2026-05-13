# Auto-answer AskUserQuestion modals when answer is known

## Goal
When the `/close` skill (or any other) raises AskUserQuestion mid-turn, auto-pick the best option from past context and only fall back to showing the modal when the answer is genuinely ambiguous. Today every question opens a modal that blocks the user.

## Context
- `src/views/sessions/permission-modal.ts` listens to the Tauri `question-requested` event and renders `showQuestionModal`. Currently every event surfaces a modal (gated only by selected/background session).
- `/close` ran in the background (ai_todo 58 / sibling work) needs answers but cannot interactively prompt without surfacing a modal. Joe wants the runner to "just do the right thing" when the answer is obvious from prior conversation, project state, or memory.
- Out of scope: changing the skill itself. We only intercept the modal layer.

## Open questions for the spec session
1. What signal decides "answer is known"?
   - Memory file lookup keyed by question text?
   - Cached previous answer for the same prompt within a session?
   - LLM call to pick the option from question + recent transcript? (cost / latency / billing path?)
   - Per-question default flag baked into skills?
2. How do we avoid silent miss-clicks on irreversible actions (e.g. rename file, delete branch)? Likely opt-in tag per question or always-show for destructive choices.
3. Logging: where do we record "auto-answered X with option Y because Z" so Joe can audit after a /close run?

## Approach (sketch, refine in spec session)
1. In `permission-modal.ts`, before rendering, run a resolver that returns `{ answer } | null`.
2. If resolver returns an answer, POST it directly via `respond_question` IPC and skip the modal.
3. Otherwise fall through to existing UI.
4. Resolver implementations live in a new `src/shared/chat/auto-answer/` module — start with a simple in-memory cache (same question text in the same session reuses last answer) and expand from there.

## Acceptance
- Decision on the signal source documented in this todo before code lands.
- Auto-answered questions are recorded somewhere user-visible (banner toast, COMMENTS.md entry, or chat synthetic message).
- Destructive questions still always open the modal.
- Manual modal flow unchanged when resolver returns null.

## Related
- `[[58-...]]` placeholder for the /close-hides-window companion work (currently in `src/views/sessions/active-session.ts` `isCloseCommand` + `dismountActivePane`).
- `src/views/sessions/permission-modal.ts`
- Backend: `src-tauri/src/mcp/server.rs` (ask_user_question tool), `src-tauri/src/hooks/server.rs` (`/questions/request|respond`).
