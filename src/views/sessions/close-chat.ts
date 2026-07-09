import { invoke } from "../../shared/ipc";
import { api } from "../../shared/api";
import { state } from "./state";
import { characterForSession } from "./session-characters";
import { askConfirm } from "../../shared/confirm";

export async function closeChat(sessionId: string): Promise<void> {
  const sess = state.sessions.find((s) => s.session_id === sessionId);
  if (sess?.busy) {
    const ok = await askConfirm("A turn is in progress. Close and discard it?", { confirmLabel: "Discard" });
    if (!ok) return;
    try { await invoke<void>("cancel_turn", { sessionId }); } catch { /* best-effort */ }
  }
  // Closing cue: play the session character's "death" slot (best-effort;
  // per-slot toggle + mute enforced in the Rust command).
  if (sess) {
    const charId = characterForSession(sess);
    if (charId) void api.playCharacterSlot(charId, "death").catch(() => { /* best-effort */ });
  }
  try {
    await invoke<void>("clear_session", { sessionId });
    document.dispatchEvent(new CustomEvent("cc:session-closed", { detail: { sessionId } }));
  } catch (err) {
    console.error("[sessions] close chat failed", err);
  }
}
