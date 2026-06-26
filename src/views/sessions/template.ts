import { html } from "lit-html";
import { openSidemenu } from "../../shared/sidemenu";
import { showView } from "../../shared/navigation";

export function template() {
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
        <button
          class="icon-btn sessions-back"
          id="sessionsBackBtn"
          title="Back to chats list"
        >
          <i class="ph ph-arrow-left"></i>
        </button>
        <h2>Chats</h2>
        <button
          class="icon-btn more-btn"
          id="viewMoreBtn"
          title="More options"
        >
          <i class="ph ph-dots-three-vertical"></i>
        </button>
      </div>
      <!--
        Host for the controls that now live inside the "more options" overflow
        menu. They render here (hidden) so their existing handlers in
        sessions.ts still bind by id at mount; openViewMoreMenu() relocates the
        live nodes into the menu on open and moves them back on close, keeping
        the bound listeners intact.
      -->
      <div id="view-more-host" hidden>
        <label class="view-more-sort-label" for="sessions-sort">Sort by</label>
        <select id="sessions-sort" class="sessions-sort sessions-sort-inline">
          <option value="status">Status</option>
          <option value="recent">Recent</option>
          <option value="name">Name</option>
          <option value="drain">Token drain</option>
        </select>
        <button
          class="smore-item"
          id="newSessionBtn"
          title="Loading..."
          disabled
        >
          <i class="ph ph-plus"></i>New chat
        </button>
        <button
          class="smore-item"
          id="historyBtn"
          title="History"
          @click=${() => showView("history")}
        >
          <i class="ph ph-clock-counter-clockwise"></i>History
        </button>
      </div>
      <div id="rate-limit-banner-host" class="rate-limit-banner-host" hidden></div>
      <div class="view-body sessions-layout">
        <aside class="sessions-sidebar">
          <ul id="sessions-list" class="sessions-list"></ul>
          <button
            class="sessions-fab"
            id="sessionsFab"
            title="New chat"
            aria-label="New chat"
          >
            <i class="ph ph-plus"></i>
          </button>
        </aside>
        <main class="session-pane" id="session-pane">
          <div class="session-empty session-empty--setup"><i class="ph ph-spinner"></i><span>Setting up...</span></div>
        </main>
      </div>
    </div>
  `;
}

/**
 * Detached-window pane shell. Renders ONLY the chat pane (no sidebar, no
 * header). Used when the URL hash starts with `#detached?session=...`.
 */
export function detachedTemplate(sessionId: string) {
  return html`
    <div class="view view-sessions detached">
      <div class="view-body sessions-layout detached-layout">
        <main class="session-pane" id="session-pane" data-session-id=${sessionId}>
          <div class="session-empty">Loading...</div>
        </main>
      </div>
    </div>
  `;
}
