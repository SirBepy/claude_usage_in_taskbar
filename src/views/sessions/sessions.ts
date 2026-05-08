import { html, render } from "lit-html";
import { openSidemenu } from "../../shared/sidemenu";
import "./sessions.css";

/**
 * Sessions view - the live chat hub. v1 scaffold renders an empty layout:
 * filter input + session list (sidebar) + main pane with empty state.
 * Phase 5b/5c wire the renderer, composer, and IPC events.
 */
export async function renderSessionsView(root: HTMLElement): Promise<() => void> {
  render(template(), root);

  // No live state to subscribe to yet (Phase 5c adds the instances-changed
  // listener and the +New click handler). Returning a no-op teardown.
  return () => {
    /* no-op for now */
  };
}

function template() {
  return html`
    <div class="view view-sessions">
      <div class="view-header">
        <button
          class="icon-btn burger"
          title="Menu"
          data-burger="true"
          @click=${openSidemenu}
        >
          <i class="ph ph-list"></i>
        </button>
        <h2>Sessions</h2>
        <button
          class="icon-btn"
          id="newSessionBtn"
          title="New session (wired in Phase 5c)"
          disabled
        >
          <i class="ph ph-plus"></i>
        </button>
      </div>
      <div class="view-body sessions-layout">
        <aside class="sessions-sidebar">
          <input
            id="sessions-filter"
            class="sessions-filter"
            type="search"
            placeholder="Filter"
          />
          <ul id="sessions-list" class="sessions-list"></ul>
        </aside>
        <main class="session-pane" id="session-pane">
          <div class="session-empty">Select or create a session</div>
        </main>
      </div>
    </div>
  `;
}
