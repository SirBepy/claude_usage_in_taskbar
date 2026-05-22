import { html, render } from "lit-html";
import { showToast } from "../../shared/toast";
import { backFromSubview } from "../../shared/navigation";
import { getCurrentSessionRecord } from "../../shared/state";
import { formatTokens } from "../../shared/tokens";
import { api } from "../../shared/api";
import { projectSubviewHeaderData, subviewHeaderTemplate, hydrateSubviewHeader } from "../project-detail/subview-header";
import type { Avatar } from "../project-detail/subview-header";
import "./session-detail.css";


interface SessionRecord {
  session_id?: string;
  kind?: string;
  pid?: number;
  project_id?: string;
  is_remote?: boolean;
  bridge_session_id?: string | null;
  name?: string | null;
  started_at?: string;
  date?: string;
  turns?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

interface LiveStats {
  tokens?: number;
  turns?: number;
  prompts?: number;
}

function isLive(r: SessionRecord | null): boolean {
  return !!(r && r.session_id && r.kind);
}

function totalTok(r: SessionRecord): number {
  return (r.inputTokens || 0) + (r.outputTokens || 0) + (r.cacheReadTokens || 0) + (r.cacheCreationTokens || 0);
}

function cacheEffPct(r: SessionRecord): number {
  const denom = (r.inputTokens || 0) + (r.cacheReadTokens || 0) + (r.cacheCreationTokens || 0);
  if (!denom) return 0;
  return Math.round((r.cacheReadTokens || 0) / denom * 100);
}

function uptimeFrom(iso: string | undefined): string {
  if (!iso) return "-";
  const start = new Date(iso).getTime();
  const delta = Math.max(0, Date.now() - start);
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function renderBody(r: SessionRecord, liveStats?: LiveStats): void {
  const body = document.getElementById("session-detail-body");
  if (!body) return;
  const live = isLive(r);
  let rows: [string, string][];
  if (live) {
    const s = liveStats || {};
    rows = [
      ["Started", r.started_at || "-"],
      ["Uptime", uptimeFrom(r.started_at)],
      ["Prompts", String(s.prompts ?? 0)],
      ["Turns", String(s.turns ?? 0)],
      ["Tokens", formatTokens(s.tokens ?? 0)],
      ["PID", (r.pid ?? 0) > 0 ? String(r.pid) : "?"],
      ["Session id", r.session_id || "-"],
    ];
  } else {
    rows = [
      ["Date", r.date || "-"],
      ["Turns", String(r.turns ?? 0)],
      ["Total tokens", formatTokens(totalTok(r))],
      ["Input", formatTokens(r.inputTokens ?? 0)],
      ["Output", formatTokens(r.outputTokens ?? 0)],
      ["Cache read", formatTokens(r.cacheReadTokens ?? 0)],
      ["Cache create", formatTokens(r.cacheCreationTokens ?? 0)],
      ["Cache efficiency", `${cacheEffPct(r)}%`],
    ];
  }
  body.innerHTML = `<div class="session-detail-list">${rows.map(([k, v]) => `
    <div class="session-detail-row"><span class="label">${k}</span><span>${v}</span></div>
  `).join("")}</div>`;
}

function renderChrome(r: SessionRecord): void {
  const chips = document.getElementById("session-detail-chips");
  const actions = document.getElementById("session-detail-actions");
  const live = isLive(r);
  if (!live) {
    if (chips) { chips.style.display = "none"; chips.innerHTML = ""; }
    if (actions) { actions.style.display = "none"; actions.innerHTML = ""; }
    return;
  }
  if (chips) {
    const parts = [`<span class="chip active">● Active</span>`];
    if (r.kind === "automated") parts.push(`<span class="chip automated">⚙ Automated</span>`);
    if (r.is_remote) parts.push(`<span class="chip remote">📱 Remote</span>`);
    chips.innerHTML = parts.join("");
    chips.style.display = "flex";
  }
  if (actions) {
    const isAutomated = r.kind === "automated";
    const projectId = r.project_id;
    const buttons: string[] = [];
    if (isAutomated) buttons.push(`<button class="act-btn" data-act="term">term</button>`);
    if (r.bridge_session_id) buttons.push(`<button class="act-btn" data-act="phone">phone</button>`);
    if (isAutomated) {
      buttons.push(`<button class="act-btn" data-act="restart">restart</button>`);
      buttons.push(`<button class="act-btn" data-act="stop">stop</button>`);
    }
    if (!buttons.length) {
      actions.style.display = "none";
      actions.innerHTML = "";
    } else {
      actions.innerHTML = buttons.join("");
      actions.style.display = "flex";
      actions.querySelectorAll<HTMLButtonElement>(".act-btn").forEach((btn) => {
        btn.onclick = async () => {
          const act = btn.dataset.act;
          try {
            if (act === "term" && projectId) await api.showTerminal(projectId);
            else if (act === "restart" && projectId) { await api.restartChannel(projectId); showToast("Restarting…"); }
            else if (act === "stop" && projectId) { await api.stopChannel(projectId); showToast("Stopped."); }
            else if (act === "phone" && r.session_id) {
              const url = await api.phoneLink(r.session_id);
              if (!url) return showToast("Phone link not available yet.");
              await navigator.clipboard.writeText(url);
              showToast(`Copied: ${url}`);
            }
          } catch (e) { showToast(`${act} failed: ${e}`); }
        };
      });
    }
  }
}

export async function renderSessionDetailView(
  root: HTMLElement,
): Promise<() => void> {
  const r = getCurrentSessionRecord() as SessionRecord | null;
  const { avatar } = projectSubviewHeaderData();
  const title = r
    ? isLive(r)
      ? ((r.name && r.name.trim()) || `Live session ${(r.session_id || "").slice(0, 8) || "?"}`)
      : ((r.session_id || (r as { sessionId?: string }).sessionId || "").slice(0, 8) || r.date || "unknown")
    : "Session";
  render(template(avatar, title), root);
  void hydrateSubviewHeader(root);

  if (!r) return () => { /* nothing */ };

  renderChrome(r);
  renderBody(r);

  let timer: ReturnType<typeof setInterval> | null = null;
  if (isLive(r) && r.session_id) {
    const sid = r.session_id;
    const tick = async () => {
      try {
        const stats = (await api.instanceTokenStats(sid)) as unknown as LiveStats;
        if ((getCurrentSessionRecord() as SessionRecord | null)?.session_id !== sid) return;
        renderBody(r, stats);
      } catch { /* ignore transient */ }
    };
    timer = setInterval(tick, 2500);
  }

  return () => {
    if (timer) { clearInterval(timer); timer = null; }
  };
}

function template(avatar: Avatar, title: string) {
  return html`
    <div class="view view-session-detail">
      <div class="view-header subview-header">
        ${subviewHeaderTemplate(avatar, title, () => backFromSubview())}
      </div>
      <div class="view-body">
        <div id="session-detail-chips" class="chip-bar" style="display:none"></div>
        <div id="session-detail-actions" class="actions session-detail-actions" style="display:none"></div>
        <div class="section" style="margin-top:12px">
          <div id="session-detail-body"></div>
        </div>
      </div>
    </div>
  `;
}
