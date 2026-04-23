import { html, render } from "lit-html";
import { openSidemenu } from "../../shared/sidemenu";
import "./statistics.css";

type LegacyRecord = {
  hour: string;
  session_pct: number;
  weekly_pct: number;
  session_resets_at: string | null;
  weekly_resets_at: string | null;
};

interface LegacyGlobals {
  electronAPI?: {
    getUsageHistory(): Promise<LegacyRecord[]>;
    onHistoryUpdated(cb: (h: LegacyRecord[]) => void): () => void;
  };
  renderStatistics(history: LegacyRecord[]): void;
  wireProjectListClicks(container: HTMLElement, onSort: () => void): void;
  refreshDashboard(): void;
}

function g(): LegacyGlobals {
  return window as unknown as LegacyGlobals;
}

let lastHistory: LegacyRecord[] | null = null;

export async function renderStatisticsView(
  root: HTMLElement,
): Promise<() => void> {
  render(template(), root);
  const content = root.querySelector<HTMLElement>("#statistics-content");

  const api = g().electronAPI;
  if (api && !lastHistory) {
    try {
      lastHistory = await api.getUsageHistory();
    } catch (e) {
      console.error("[statistics] initial history fetch failed", e);
    }
  }
  fill();

  const unlisten = api?.onHistoryUpdated((h) => {
    lastHistory = h;
    fill();
  });

  const onRefresh = () => fill();
  window.addEventListener("refresh-dashboard-home", onRefresh);

  function fill(): void {
    const c = root.querySelector<HTMLElement>("#statistics-content");
    if (!c) return;
    if (!lastHistory || lastHistory.length === 0) {
      c.innerHTML = `<div class="no-data">No data yet.</div>`;
      return;
    }
    g().renderStatistics(lastHistory);
    g().wireProjectListClicks(c, () => g().refreshDashboard());
  }

  // Dev note: `content` is used implicitly by the #statistics-content selector
  // inside `fill()`; reference it here to silence no-unused-vars.
  void content;

  return () => {
    try { unlisten?.(); } catch { /* ignore */ }
    window.removeEventListener("refresh-dashboard-home", onRefresh);
  };
}

function template() {
  return html`
    <div class="view view-statistics">
      <div class="view-header">
        <button
          class="icon-btn burger"
          title="Menu"
          data-burger="true"
          @click=${openSidemenu}
        >
          <i class="ph ph-list"></i>
        </button>
        <h2>Statistics</h2>
        <div style="width:32px"></div>
      </div>
      <div class="view-body">
        <div id="statistics-content">
          <div class="no-data">No data yet.</div>
        </div>
      </div>
    </div>
  `;
}
