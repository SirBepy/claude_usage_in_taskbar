import { state, setActiveSession } from "../../../views/sessions/state";
import type { BuiltinHandler } from "./index";

export const exitSession: BuiltinHandler = () => {
  if (state.renderer) {
    state.renderer.detach();
    state.renderer = null;
  }
  if (state.statusbar) {
    state.statusbar.destroy();
    state.statusbar = null;
  }
  state.composer?.destroy();
  state.composer = null;
  setActiveSession(null);

  // Clear the visible pane to the empty state.
  const pane = document.querySelector<HTMLElement>(".session-pane #session-pane")
    ?? document.querySelector<HTMLElement>("#session-pane");
  if (pane) {
    pane.innerHTML = `<div class="session-empty">Select or create a session</div>`;
  }
};
