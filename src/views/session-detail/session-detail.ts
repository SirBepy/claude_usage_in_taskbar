import { html, render } from "lit-html";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import type { TemplateResult } from "lit-html";
import { showToast } from "../../shared/toast";
import { backFromSubview, showView } from "../../shared/navigation";
import { getCurrentSessionRecord } from "../../shared/state";
import { formatTokens } from "../../shared/tokens";
import { buildPieSvg } from "../../shared/pie";
import { escapeHtml } from "../../shared/escape-html";
import { api } from "../../shared/api";
import { invoke } from "../../shared/ipc";
import type { ChatEvent, HistoryEntry } from "../../types/ipc.generated";
import { renderAvatar } from "../../shared/projects";
import { projectSubviewHeaderData, hydrateSubviewHeader } from "../project-detail/subview-header";
import type { Avatar } from "../project-detail/subview-header";
import { queueSessionSelect } from "../sessions/sessions";
import { queueHistorySelect } from "../history/history";
import "./session-detail.css";


interface SessionRecord {
  session_id?: string;
  sessionId?: string;
  kind?: string;
  pid?: number;
  project_id?: string;
  is_remote?: boolean;
  bridge_session_id?: string | null;
  name?: string | null;
  started_at?: string;
  startedAt?: string;
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

const PIE = {
  input: "#9d7dfc",
  output: "#f2b457",
  cacheRead: "#6ad98a",
  cacheCreate: "#8a9eff",
};

function isLive(r: SessionRecord | null): boolean {
  return !!(r && r.session_id && r.kind);
}

function sessionIdOf(r: SessionRecord): string {
  return r.session_id || r.sessionId || "";
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

function dateTimeParts(r: SessionRecord, startedAtMs: number | null): { date: string; time: string } {
  const ms = startedAtMs
    ?? (r.startedAt ? new Date(r.startedAt).getTime() : null)
    ?? (r.started_at ? new Date(r.started_at).getTime() : null);
  if (ms && !Number.isNaN(ms)) {
    const d = new Date(ms);
    return {
      date: d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }),
      time: d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
    };
  }
  return { date: r.date || "-", time: "-" };
}

// ── Card rendering ──────────────────────────────────────────────────────────

interface CardCtx {
  title: string;
  startedAtMs: number | null;
  liveStats?: LiveStats;
  messages: number | null; // null = still loading
}

function pieCard(r: SessionRecord): string {
  const input = r.inputTokens || 0;
  const output = r.outputTokens || 0;
  const cacheRead = r.cacheReadTokens || 0;
  const cacheCreate = r.cacheCreationTokens || 0;
  const total = input + output + cacheRead + cacheCreate;
  if (total <= 0) {
    return `<div class="sd-card"><div class="sd-card-title">Token breakdown</div>
      <div class="sd-empty">No token data</div></div>`;
  }
  const slices = [
    { label: "Input", value: input, color: PIE.input },
    { label: "Output", value: output, color: PIE.output },
    { label: "Cache read", value: cacheRead, color: PIE.cacheRead },
    { label: "Cache create", value: cacheCreate, color: PIE.cacheCreate },
  ];
  const svg = buildPieSvg(slices.map((s) => ({ value: s.value, color: s.color })), total, { r: 46, cx: 52, cy: 52, size: 104 });
  const legend = slices.map((s) => `
    <div class="sd-legend-item">
      <span class="sd-swatch" style="background:${s.color}"></span>
      <span class="sd-legend-label">${s.label}</span>
      <span class="sd-legend-val">${formatTokens(s.value)}</span>
    </div>`).join("");
  return `<div class="sd-card"><div class="sd-card-title">Token breakdown</div>
    <div class="sd-pie-wrap">${svg}<div class="sd-legend">${legend}</div></div></div>`;
}

function cacheCard(r: SessionRecord): string {
  return `<div class="sd-card"><div class="sd-card-title">Cache</div>
    <div class="sd-cache">
      <div class="sd-cache-row"><span>Read</span><span>${formatTokens(r.cacheReadTokens || 0)}</span></div>
      <div class="sd-cache-row"><span>Created</span><span>${formatTokens(r.cacheCreationTokens || 0)}</span></div>
      <div class="sd-cache-row"><span>Efficiency</span><span>${cacheEffPct(r)}%</span></div>
    </div></div>`;
}

function countsCard(turns: number, messages: number | null): string {
  const msg = messages === null ? "…" : String(messages);
  return `<div class="sd-card"><div class="sd-counts">
    <div class="sd-count"><div class="sd-count-label">Turns</div><div class="sd-count-value">${turns}</div></div>
    <div class="sd-count"><div class="sd-count-label">Messages</div><div class="sd-count-value">${msg}</div></div>
  </div></div>`;
}

function renderCards(r: SessionRecord, ctx: CardCtx): void {
  const body = document.getElementById("session-detail-body");
  if (!body) return;
  const live = isLive(r);
  const { date, time } = dateTimeParts(r, ctx.startedAtMs);

  let overview: string;
  let counts: string;
  let extra = "";

  if (live) {
    const s = ctx.liveStats || {};
    overview = `<div class="sd-card sd-overview">
      <div class="sd-title">${escapeHtml(ctx.title)}</div>
      <div class="sd-meta-row">
        <span><span class="sd-meta-label">Started</span> ${date} · ${time}</span>
        <span class="sd-meta-sep">|</span>
        <span><span class="sd-meta-label">Up</span> ${uptimeFrom(r.started_at)}</span>
      </div>
      <div class="sd-total"><span class="sd-meta-label">Total tokens</span> ${formatTokens(s.tokens ?? 0)}</div>
    </div>`;
    counts = countsCard(s.turns ?? 0, s.prompts ?? 0);
  } else {
    overview = `<div class="sd-card sd-overview">
      <div class="sd-title">${escapeHtml(ctx.title)}</div>
      <div class="sd-meta-row">
        <span><span class="sd-meta-label">Date</span> ${date}</span>
        <span class="sd-meta-sep">|</span>
        <span><span class="sd-meta-label">Time</span> ${time}</span>
      </div>
      <div class="sd-total"><span class="sd-meta-label">Total tokens</span> ${formatTokens(totalTok(r))}</div>
    </div>`;
    counts = countsCard(r.turns ?? 0, ctx.messages);
    extra = pieCard(r) + cacheCard(r);
  }

  body.innerHTML = `<div class="sd-cards">${overview}${counts}${extra}</div>`;
}

// ── Live chips + automated actions (carried over) ────────────────────────────

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

// ── More-options menu + CTA ───────────────────────────────────────────────────

function wireMenu(root: HTMLElement, r: SessionRecord): void {
  const menuBtn = root.querySelector<HTMLButtonElement>("#sessionDetailMenuBtn");
  const menu = root.querySelector<HTMLElement>("#sessionDetailMenu");
  if (!menuBtn || !menu) return;
  const sid = sessionIdOf(r);
  const onDocClick = (e: MouseEvent) => {
    if (menu.classList.contains("hidden")) return;
    const target = e.target as Node;
    if (menu.contains(target) || menuBtn.contains(target)) return;
    menu.classList.add("hidden");
  };
  menuBtn.onclick = (e: MouseEvent) => { e.stopPropagation(); menu.classList.toggle("hidden"); };
  menu.querySelectorAll<HTMLButtonElement>(".menu-item").forEach((btn) => {
    btn.onclick = async () => {
      menu.classList.add("hidden");
      const act = btn.dataset.act;
      try {
        if (act === "copy-pid" && (r.pid ?? 0) > 0) {
          await navigator.clipboard.writeText(String(r.pid));
          showToast(`Copied PID ${r.pid}`);
        } else if (act === "copy-sid" && sid) {
          await navigator.clipboard.writeText(sid);
          showToast("Copied session id");
        }
      } catch (err) { showToast(`Copy failed: ${err}`); }
    };
  });
  document.addEventListener("click", onDocClick);
  // Stash cleanup on the menu element so the view teardown can remove it.
  (menu as unknown as { _cleanup?: () => void })._cleanup = () =>
    document.removeEventListener("click", onDocClick);
}

function wireCta(root: HTMLElement, r: SessionRecord): void {
  const btn = root.querySelector<HTMLButtonElement>("#sessionOpenInChatsBtn");
  if (!btn) return;
  const sid = sessionIdOf(r);
  btn.onclick = () => {
    if (!sid) return;
    if (isLive(r)) {
      queueSessionSelect(sid);
      showView("sessions");
    } else {
      queueHistorySelect(sid);
      showView("history");
    }
  };
}

// ── Async enrichment for historical records ──────────────────────────────────

async function enrichHistorical(r: SessionRecord, sid: string, ctx: CardCtx): Promise<void> {
  // Title + start time come from the history index (cheap, no transcript read).
  try {
    const entries = await invoke<HistoryEntry[]>("list_history", { projectId: null, search: null, limit: 500, offset: 0 });
    const entry = (entries || []).find((e) => e.session_id === sid);
    if (entry) {
      if (entry.title) {
        ctx.title = entry.title;
        const h2 = document.getElementById("sessionDetailTitle");
        if (h2) h2.textContent = entry.title;
      }
      if (!ctx.startedAtMs && entry.started_at) {
        ctx.startedAtMs = Number(entry.started_at) * 1000; // history timestamps are seconds
      }
    }
  } catch { /* best-effort */ }

  // Message count needs the transcript; count user_message events.
  try {
    const events = await invoke<ChatEvent[]>("load_history", { sessionId: sid, cwd: null });
    ctx.messages = (events || []).filter((e) => e.type === "user_message").length;
  } catch {
    ctx.messages = 0;
  }
  // Re-render with whatever we resolved (title/date/messages).
  if (sessionIdOf((getCurrentSessionRecord() as SessionRecord | null) || {}) === sid) {
    renderCards(r, ctx);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function renderSessionDetailView(
  root: HTMLElement,
): Promise<() => void> {
  const r = getCurrentSessionRecord() as SessionRecord | null;
  const { avatar } = projectSubviewHeaderData();
  const live = isLive(r);
  const sid = r ? sessionIdOf(r) : "";

  const fallbackTitle = r
    ? live
      ? ((r.name && r.name.trim()) || `Live session ${sid.slice(0, 8) || "?"}`)
      : `Chat ${sid.slice(0, 8) || ""}`.trim() || r.date || "Session"
    : "Session";

  render(template(avatar, fallbackTitle, r), root);
  void hydrateSubviewHeader(root);

  if (!r) return () => { /* nothing */ };

  wireMenu(root, r);
  wireCta(root, r);
  renderChrome(r);

  const ctx: CardCtx = {
    title: fallbackTitle,
    startedAtMs: live
      ? (r.started_at ? new Date(r.started_at).getTime() : null)
      : (r.startedAt ? new Date(r.startedAt).getTime() : null),
    liveStats: undefined,
    messages: live ? 0 : null,
  };
  renderCards(r, ctx);

  if (!live && sid) {
    void enrichHistorical(r, sid, ctx);
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  if (live && r.session_id) {
    const liveSid = r.session_id;
    const tick = async () => {
      try {
        const stats = (await api.instanceTokenStats(liveSid)) as unknown as LiveStats;
        if ((getCurrentSessionRecord() as SessionRecord | null)?.session_id !== liveSid) return;
        ctx.liveStats = stats;
        renderCards(r, ctx);
      } catch { /* ignore transient */ }
    };
    void tick();
    timer = setInterval(tick, 2500);
  }

  return () => {
    if (timer) { clearInterval(timer); timer = null; }
    const menu = root.querySelector<HTMLElement>("#sessionDetailMenu") as unknown as { _cleanup?: () => void } | null;
    try { menu?._cleanup?.(); } catch { /* ignore */ }
  };
}

function menuTemplate(r: SessionRecord | null): TemplateResult {
  const hasPid = !!r && (r.pid ?? 0) > 0;
  return html`
    <div class="menu-anchor">
      <button class="icon-btn" id="sessionDetailMenuBtn" title="More options">
        <i class="ph ph-dots-three-vertical"></i>
      </button>
      <div id="sessionDetailMenu" class="menu-popover hidden" role="menu">
        ${hasPid ? html`<button class="menu-item" data-act="copy-pid" role="menuitem">Copy PID</button>` : ""}
        <button class="menu-item" data-act="copy-sid" role="menuitem">Copy Session id</button>
      </div>
    </div>
  `;
}

function template(avatar: Avatar, title: string, r: SessionRecord | null) {
  return html`
    <div class="view view-session-detail">
      <div class="view-header subview-header">
        <button class="icon-btn" title="Back" @click=${() => backFromSubview()}><i class="ph ph-arrow-left"></i></button>
        <div class="project-detail-heading">
          <div class="avatar-mini">${unsafeHTML(renderAvatar(avatar))}</div>
          <div class="project-detail-titles">
            <h2 id="sessionDetailTitle" style="font-size:0.88rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title=${title}>${title}</h2>
          </div>
        </div>
        ${menuTemplate(r)}
      </div>
      <div class="view-body">
        <div id="session-detail-chips" class="chip-bar" style="display:none"></div>
        <div id="session-detail-actions" class="actions session-detail-actions" style="display:none"></div>
        <div id="session-detail-body" style="margin-top:12px"></div>
        <button class="sd-cta" id="sessionOpenInChatsBtn">
          <i class="ph ph-chats"></i> Open in chats
        </button>
      </div>
    </div>
  `;
}
