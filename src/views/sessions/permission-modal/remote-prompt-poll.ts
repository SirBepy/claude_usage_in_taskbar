/**
 * Phone-side reconciliation of the daemon's pending-prompt store.
 *
 * The desktop learns about AskUserQuestion / permission prompts through a
 * reliable poll in the Rust app (daemon_link.rs::spawn_pending_prompt_poll):
 * it lists `list_pending_prompts`, emits each open prompt's Tauri event once,
 * and emits `prompt-resolved` when one disappears. The phone has no Tauri event
 * bus, so AUQs never reached it. This is the same demux, in JS, driven by the
 * HttpTransport poll in index.ts.
 *
 * Pure (no DOM / transport imports) so the reconciliation is unit-testable.
 */

import type { PermissionRequestedPayload, QuestionRequestedPayload } from "./types";

export interface PromptPollCallbacks {
  onQuestion: (p: QuestionRequestedPayload) => void;
  onPermission: (p: PermissionRequestedPayload) => void;
  onResolved: (id: string) => void;
}

/** One stored prompt as returned by `list_pending_prompts`:
 *  `{ id, event, payload }` (see daemon state.rs::add_prompt). */
interface StoredPrompt {
  id?: unknown;
  event?: unknown;
  payload?: unknown;
}

/**
 * Diff a fresh `list_pending_prompts` snapshot against the set of ids already
 * surfaced. New question/permission prompts fire their callback exactly once
 * (and are added to `emitted`); ids that vanished from the snapshot fire
 * `onResolved` and are dropped. Mutates `emitted` in place.
 */
export function reconcilePendingPrompts(
  prompts: unknown,
  emitted: Set<string>,
  cb: PromptPollCallbacks,
): void {
  if (!Array.isArray(prompts)) return;
  const present = new Set<string>();
  for (const raw of prompts) {
    const p = raw as StoredPrompt;
    const id = typeof p?.id === "string" ? p.id : undefined;
    if (!id) continue;
    present.add(id);
    if (emitted.has(id)) continue;
    const event = typeof p.event === "string" ? p.event : "";
    if (p.payload == null) continue;
    if (event === "question-requested") {
      cb.onQuestion(p.payload as QuestionRequestedPayload);
      emitted.add(id);
    } else if (event === "permission-requested") {
      cb.onPermission(p.payload as PermissionRequestedPayload);
      emitted.add(id);
    }
  }
  for (const id of Array.from(emitted)) {
    if (!present.has(id)) {
      cb.onResolved(id);
      emitted.delete(id);
    }
  }
}
