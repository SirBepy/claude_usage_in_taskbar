// "Handoff to next AI" feature: sends a prompt to the current chat asking
// Claude to write a session handoff file, then opens a new chat that reads
// the file and continues the work. No dependency on personal ~/.claude skills.

import { invoke } from "../../shared/ipc";
import { sessionEvents } from "../../shared/chat/event-store";
import { state } from "./state";
import { projectName } from "./sessions-helpers";
import { openModelEffortModal } from "./model-effort-modal";
import type { ContentBlock, ChatEvent } from "../../types/ipc.generated";

export const HANDOFF_PROMPT = `Please write a session handoff file for the next AI session.

Gather context by running:
1. git rev-parse --abbrev-ref HEAD
2. git log --oneline -10
3. git diff --name-only

Then write the results to \`.for_bepy/HANDOFF.md\` using this structure:

# Session Handoff

## What was accomplished
(2-4 sentences)

## Files changed
(bullet list, omit if git not available)

## Open decisions
(bullet list, or "None")

## Suggested next steps
(2-4 concrete bullets)

Create the \`.for_bepy/\` directory if it does not exist.
When the file is written, respond with exactly this on its own line:
<HANDOFF_READY/>`.trim();

const CONTINUATION_PROMPT =
  "Read the file `.for_bepy/HANDOFF.md` for context from the previous session, " +
  "then delete the file and continue the work described in \"Suggested next steps\". " +
  "If the file does not exist, ask what to work on.";

/** Send the handoff prompt to the active session. The renderer's onHandoffReady
 *  fires when Claude emits `<HANDOFF_READY/>`, triggering completeHandoff. */
export async function triggerHandoff(sessionId: string, cwd: string): Promise<void> {
  const blocks: ContentBlock[] = [{ type: "text", text: HANDOFF_PROMPT }];
  sessionEvents.pushSynthetic(sessionId, {
    type: "user_message",
    content: blocks,
    timestamp: BigInt(Date.now()),
  } as ChatEvent);
  await invoke<void>("send_message", { sessionId, cwd, blocks });
}

/** Open the new-chat modal (character / model / effort / account picker) in the
 *  same project, then launch a new chat with the continuation prompt pre-filled
 *  once the user confirms. Called by active-session when onHandoffReady fires.
 *  Mirrors the "pickup" CTA flow so handoff and pickup behave identically. */
export async function completeHandoff(sessionId: string): Promise<void> {
  const sess = state.sessions.find(s => s.session_id === sessionId);
  if (!sess) return;
  const project = { path: String(sess.cwd ?? ""), name: projectName(sess) };
  const config = await openModelEffortModal(project.path, project.name);
  if (!config) return;
  state.launchNewChatCallback?.(project, { ...config, initialMessage: CONTINUATION_PROMPT });
}
