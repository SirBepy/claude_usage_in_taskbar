import { invoke } from "../../shared/ipc";
import { state } from "./state";

export async function closeChat(sessionId: string): Promise<void> {
  const sess = state.sessions.find((s) => s.session_id === sessionId);
  if (sess?.busy) {
    if (!confirm("A turn is in progress. Close and discard it?")) return;
    try { await invoke<void>("cancel_turn", { sessionId }); } catch { /* best-effort */ }
  }
  try {
    await invoke<void>("clear_session", { sessionId });
    document.dispatchEvent(new CustomEvent("cc:session-closed", { detail: { sessionId } }));
  } catch (err) {
    console.error("[sessions] close chat failed", err);
  }
}
