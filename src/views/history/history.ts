import { html, render } from "lit-html";
import { openSidemenu } from "../../shared/sidemenu";
import "./history.css";

/**
 * History view - read-only browser of past Claude sessions. v1 scaffold renders
 * an empty layout. Phase 8b populates the list via list_history IPC and wires
 * row clicks to load_history + replay.
 */
export async function renderHistoryView(root: HTMLElement): Promise<() => void> {
  render(template(), root);
  return () => {
    /* no-op for now */
  };
}

function template() {
  return html`
    <div class="view view-history">
      <div class="view-header">
        <button
          class="icon-btn burger"
          title="Menu"
          data-burger="true"
          @click=${openSidemenu}
        >
          <i class="ph ph-list"></i>
        </button>
        <h2>History</h2>
        <div style="width:32px"></div>
      </div>
      <div class="view-body" id="history-content">
        <div class="history-empty">Past sessions appear here once you have any.</div>
      </div>
    </div>
  `;
}
