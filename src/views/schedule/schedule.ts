import { html, render } from "lit-html";
import { openSidemenu } from "../../shared/sidemenu";
import { showView } from "../../shared/navigation";
import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import { askConfirm } from "../../shared/confirm";
import { isRemote } from "../../shared/transport";
import { cwdToProjectName } from "../sessions/sessions-helpers";
import "./schedule.css";
import type {
  ScheduledItem,
  ExternalScheduledJob,
  Recurrence,
  Instance,
} from "../../types/ipc.generated";

// ── Calendar Schedule view ───────────────────────────────────────────────────
//
// Month grid + per-day agenda. Replaces the old flat list. Recurring items are
// expanded client-side onto every occurrence within the visible grid (the
// backend only stores the *next* fire_at + the recurrence rule), so a daily
// message shows on every day, a weekly one on its weekdays, etc. Clicking an
// agenda item navigates to the chat it targets (open_chats_for_session, which
// resumes a closed chat). Rendered both as a route in the dashboard and, more
// usefully, standalone in the `session-schedule` window.

type DotStatus = "upcoming" | "firing" | "sent" | "failed" | "missed" | "external";

/** One placement of an item on a specific calendar day. */
interface Occurrence {
  /** yyyy-mm-dd local key for the day this lands on. */
  dayKey: string;
  /** epoch millis of the exact local instant (for sorting within a day). */
  time: number;
  status: DotStatus;
  /** Underlying scheduled item, or null for an external Task-Scheduler job. */
  item: ScheduledItem | null;
  external?: ExternalScheduledJob;
  /** True when this occurrence is a projected future repeat (hollow ring). */
  recurring: boolean;
}

interface ScheduleState {
  mountId: number;
  items: ScheduledItem[];
  external: ExternalScheduledJob[];
  /** session_id -> chat title (Instance.name), for live-vs-history + labels. */
  titles: Map<string, string>;
  loading: boolean;
  /** First of the visible month (local). */
  viewYear: number;
  viewMonth: number; // 0-based
  /** Selected day key (yyyy-mm-dd) whose agenda is shown, or null. */
  selectedKey: string | null;
  /** id of the row currently showing its inline reschedule datetime picker. */
  reschedulingId: string | null;
}

function todayKey(): string {
  return dayKeyOf(new Date());
}

const now0 = new Date();
let state: ScheduleState = freshState(0);
let nextMountId = 1;

function freshState(mountId: number): ScheduleState {
  return {
    mountId,
    items: [],
    external: [],
    titles: new Map(),
    loading: true,
    viewYear: now0.getFullYear(),
    viewMonth: now0.getMonth(),
    selectedKey: todayKey(),
    reschedulingId: null,
  };
}

async function fetchAll(): Promise<void> {
  try {
    const [items, external, instances] = await Promise.all([
      invoke<ScheduledItem[]>("schedule_list").catch(() => [] as ScheduledItem[]),
      invoke<ExternalScheduledJob[]>("schedule_list_external").catch(() => [] as ExternalScheduledJob[]),
      invoke<Instance[]>("list_instances").catch(() => [] as Instance[]),
    ]);
    state.items = items || [];
    state.external = external || [];
    state.titles = new Map((instances || []).map((i) => [i.session_id, i.name || ""]));
  } catch (err) {
    console.error("[schedule] fetch failed", err);
    state.items = [];
    state.external = [];
    state.titles = new Map();
  } finally {
    state.loading = false;
  }
}

// ── date helpers ─────────────────────────────────────────────────────────────

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function dayKeyOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** `schedule_list_external`'s `humanTime` is a local "yyyy-MM-dd HH:mm:ss"
 * string (not RFC3339) - reparse as a local wall-clock Date. */
function dateFromHumanTime(humanTime: string): Date | null {
  const d = new Date(humanTime.replace(" ", "T"));
  return isNaN(d.getTime()) ? null : d;
}

// ── recurrence expansion (mirror of scheduled_items.rs next_occurrence) ───────

function parseHhmm(s: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return [0, 0];
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return [0, 0];
  return [h, mi];
}

/** Next local occurrence strictly after `after`, per rule. Mirrors the Rust. */
function nextOccurrence(after: Date, rec: Recurrence): Date {
  const [hour, minute] = parseHhmm(rec.time);
  const atTime = (base: Date): Date => new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0);

  if (rec.rule.type === "daily") {
    const today = atTime(after);
    if (today > after) return today;
    const t = new Date(after);
    t.setDate(t.getDate() + 1);
    return atTime(t);
  }
  if (rec.rule.type === "weekly") {
    const weekdays = rec.rule.weekdays; // 0=Mon..6=Sun
    if (!weekdays.length) {
      const t = new Date(after);
      t.setDate(t.getDate() + 1);
      return atTime(t);
    }
    for (let offset = 0; offset <= 7; offset++) {
      const d = new Date(after);
      d.setDate(d.getDate() + offset);
      const dow = (d.getDay() + 6) % 7; // JS Sun=0 -> Mon=0
      if (!weekdays.includes(dow)) continue;
      const cand = atTime(d);
      if (cand > after) return cand;
    }
    const t = new Date(after);
    t.setDate(t.getDate() + 7);
    return atTime(t);
  }
  // every_n_days
  const n = Math.max(1, rec.rule.n);
  const today = atTime(after);
  if (today > after) return today;
  const t = new Date(after);
  t.setDate(t.getDate() + n);
  return atTime(t);
}

/** All occurrence instants of a recurring item within [start, end] (inclusive
 * day range), starting from its stored next fire_at. Capped to avoid runaway. */
function expandRecurrence(fireAt: Date, rec: Recurrence, end: Date): Date[] {
  const out: Date[] = [];
  let cur = fireAt;
  let guard = 0;
  while (cur <= end && guard < 500) {
    out.push(new Date(cur));
    cur = nextOccurrence(cur, rec);
    guard++;
  }
  return out;
}

// ── build occurrences for the visible grid ───────────────────────────────────

/** The 6-week grid range (Mon-start) covering the visible month. */
function gridRange(year: number, month: number): { start: Date; end: Date; cells: Date[] } {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7; // Mon=0
  const start = new Date(year, month, 1 - lead);
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    cells.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }
  const last = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 41);
  const end = new Date(last.getFullYear(), last.getMonth(), last.getDate(), 23, 59, 59);
  return { start, end, cells };
}

function isPastStatus(t: ScheduledItem["status"]["type"]): boolean {
  return t === "sent" || t === "failed" || t === "missed";
}

function buildOccurrences(rangeEnd: Date): Map<string, Occurrence[]> {
  const byDay = new Map<string, Occurrence[]>();
  const push = (occ: Occurrence) => {
    const arr = byDay.get(occ.dayKey);
    if (arr) arr.push(occ);
    else byDay.set(occ.dayKey, [occ]);
  };

  for (const item of state.items) {
    const st = item.status.type;
    if (isPastStatus(st)) {
      // Past: place on when it actually fired (fall back to fire_at).
      const when = new Date(item.last_fired_at || item.fire_at);
      if (isNaN(when.getTime())) continue;
      push({ dayKey: dayKeyOf(when), time: when.getTime(), status: st as DotStatus, item, recurring: false });
      continue;
    }
    // Pending / firing (upcoming).
    const base = new Date(item.fire_at);
    if (isNaN(base.getTime())) continue;
    const instants = item.recurrence
      ? expandRecurrence(base, item.recurrence, rangeEnd)
      : [base];
    for (const inst of instants) {
      const isBase = inst.getTime() === base.getTime();
      push({
        dayKey: dayKeyOf(inst),
        time: inst.getTime(),
        // Only the concrete next fire can be mid-"firing"; projected repeats are upcoming.
        status: st === "firing" && isBase ? "firing" : "upcoming",
        item,
        recurring: !!item.recurrence,
      });
    }
  }

  for (const job of state.external) {
    const d = job.fire_at ? dateFromHumanTime(job.fire_at) : null;
    if (!d) continue;
    push({ dayKey: dayKeyOf(d), time: d.getTime(), status: "external", item: null, external: job, recurring: false });
  }

  return byDay;
}

// ── labels ───────────────────────────────────────────────────────────────────

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n).trimEnd()}…` : t;
}

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DOW_HEAD = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function recurrenceBadge(rec: Recurrence | null): string {
  if (!rec) return "";
  let label = "";
  switch (rec.rule.type) {
    case "daily": label = "daily"; break;
    case "weekly": label = `weekly ${rec.rule.weekdays.map((w) => WEEKDAY_LABELS[w] ?? "?").join(" ")}`; break;
    case "every_n_days": label = `every ${rec.rule.n}d`; break;
  }
  return label
    ? `<span class="schedule-badge schedule-badge--recurrence"><i class="ph ph-repeat"></i>${escapeHtml(label)}</span>`
    : "";
}

function kindIconClass(item: ScheduledItem): string {
  return item.kind.type === "new_chat" ? "ph-plus-circle" : "ph-paper-plane-tilt";
}

function targetLabel(item: ScheduledItem): string {
  if (item.kind.type === "new_chat") {
    return `New chat: ${cwdToProjectName(item.kind.cwd)}`;
  }
  const title = state.titles.get(item.kind.session_id);
  if (title) return title;
  return truncate(item.prompt, 60);
}

/** Resolve the session id (and live/history mode) an item's chat opens as, or
 * null when there's nothing to open yet (an un-fired New chat has no session). */
function navTarget(item: ScheduledItem): { sessionId: string; mode: string } | null {
  let sessionId: string | null = null;
  if (item.kind.type === "message") sessionId = item.kind.session_id;
  else sessionId = item.last_session_id ?? null; // new_chat: set once it fires
  if (!sessionId) return null;
  const mode = state.titles.has(sessionId) ? "live" : "history";
  return { sessionId, mode };
}

function statusPill(status: DotStatus, item: ScheduledItem | null): string {
  const map: Record<DotStatus, [string, string]> = {
    upcoming: ["pending", "Upcoming"],
    firing: ["firing", "Firing…"],
    sent: ["sent", "Sent"],
    failed: ["failed", "Failed"],
    missed: ["missed", "Missed"],
    external: ["external", "Task Scheduler"],
  };
  // A projected recurring upcoming keeps the "Upcoming" label; a concrete
  // pending item is also "Upcoming" here (calendar doesn't split the two).
  const [cls, label] = map[status];
  void item;
  return `<span class="schedule-status-pill schedule-status-pill--${cls}">${label}</span>`;
}

function datetimeLocalValue(iso: string): string {
  const d = new Date(iso);
  const base = isNaN(d.getTime()) ? new Date() : d;
  return `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}T${pad(base.getHours())}:${pad(base.getMinutes())}`;
}

// ── rendering ────────────────────────────────────────────────────────────────

function dotClass(occ: Occurrence): string {
  if (occ.recurring && (occ.status === "upcoming" || occ.status === "firing")) return "dot dot--recurring";
  return `dot dot--${occ.status}`;
}

function renderGrid(byDay: Map<string, Occurrence[]>, cells: Date[]): string {
  const tKey = todayKey();
  const head = DOW_HEAD.map((d) => `<div class="cal-dow">${d}</div>`).join("");
  const cellHtml = cells.map((d) => {
    const key = dayKeyOf(d);
    const inMonth = d.getMonth() === state.viewMonth;
    const occs = (byDay.get(key) || []).slice().sort((a, b) => a.time - b.time);
    const dots = occs.slice(0, 4).map((o) => `<span class="${dotClass(o)}"></span>`).join("");
    const more = occs.length > 4 ? `<span class="cal-more">+${occs.length - 4}</span>` : "";
    const cls = [
      "cal-cell",
      inMonth ? "" : "other",
      key === tKey ? "today" : "",
      key === state.selectedKey ? "selected" : "",
    ].filter(Boolean).join(" ");
    return `<div class="${cls}" data-day="${key}">
      <span class="cal-daynum">${d.getDate()}</span>
      <div class="cal-dots">${dots}${more}</div>
    </div>`;
  }).join("");
  return `<div class="cal-grid">${head}${cellHtml}</div>`;
}

function agendaRowHtml(occ: Occurrence): string {
  const timeStr = localTime(new Date(occ.time));
  if (!occ.item && occ.external) {
    const job = occ.external;
    return `<li class="agenda-row agenda-row--external">
      <span class="agenda-time">${escapeHtml(timeStr)}</span>
      <i class="ph ph-clock-countdown agenda-icon"></i>
      <div class="agenda-main">
        <div class="agenda-name">${escapeHtml(job.label)}${job.cwd ? ` &mdash; ${escapeHtml(cwdToProjectName(job.cwd))}` : ""}</div>
        <div class="agenda-meta">${statusPill("external", null)}</div>
      </div>
    </li>`;
  }
  const item = occ.item!;
  const nav = navTarget(item);
  const rescheduleOpen = state.reschedulingId === item.id;
  const isFailed = item.status.type === "failed";
  const reason = item.status.type === "failed"
    ? item.status.reason
    : (occ.status === "failed" ? item.last_result || "" : "");
  const canFire = occ.status === "upcoming" || occ.status === "firing" || occ.status === "failed";
  const showDelete = occ.status !== "firing";
  return `<li class="agenda-row ${nav ? "agenda-row--nav" : ""}" data-id="${escapeHtml(item.id)}" ${nav ? `data-nav-session="${escapeHtml(nav.sessionId)}" data-nav-mode="${nav.mode}"` : ""}>
    <span class="agenda-time">${escapeHtml(timeStr)}</span>
    <i class="ph ${kindIconClass(item)} agenda-icon"></i>
    <div class="agenda-main">
      <div class="agenda-name">${escapeHtml(targetLabel(item))}</div>
      <div class="agenda-meta">
        ${statusPill(occ.status, item)}
        ${recurrenceBadge(item.recurrence)}
        ${reason ? `<span class="schedule-reason">${escapeHtml(reason)}</span>` : ""}
      </div>
    </div>
    <div class="agenda-actions">
      ${isRemote() ? "" : `
      ${canFire ? `<button class="icon-btn" data-action="fire-now" data-id="${escapeHtml(item.id)}" title="${isFailed ? "Retry" : "Fire now"}"><i class="ph ${isFailed ? "ph-arrow-clockwise" : "ph-play"}"></i></button>` : ""}
      ${occ.status === "upcoming" ? `<button class="icon-btn" data-action="reschedule-toggle" data-id="${escapeHtml(item.id)}" title="Reschedule"><i class="ph ph-calendar-plus"></i></button>` : ""}
      ${showDelete ? `<button class="icon-btn" data-action="delete" data-id="${escapeHtml(item.id)}" title="Delete"><i class="ph ph-trash"></i></button>` : ""}
      `}
      ${nav ? `<i class="ph ph-caret-right agenda-chevron"></i>` : ""}
    </div>
    ${rescheduleOpen && !isRemote() ? `
      <div class="schedule-reschedule-inline">
        <input type="datetime-local" data-reschedule-input="${escapeHtml(item.id)}" value="${datetimeLocalValue(item.fire_at)}">
        <button class="btn-primary" data-action="reschedule-confirm" data-id="${escapeHtml(item.id)}">Set</button>
        <button class="btn-secondary" data-action="reschedule-cancel" data-id="${escapeHtml(item.id)}">Cancel</button>
      </div>` : ""}
  </li>`;
}

function agendaTitle(key: string | null): string {
  if (!key) return "Select a day";
  const parts = key.split("-");
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  const dt = new Date(y, m - 1, d);
  const dayName = dt.toLocaleDateString(undefined, { weekday: "long" });
  return `${dayName}, ${MONTH_NAMES[m - 1]} ${d}`;
}

function renderBody(): string {
  if (state.loading) {
    return `<div class="schedule-loading"><span class="schedule-spinner"></span>Loading schedule&hellip;</div>`;
  }

  const { end, cells } = gridRange(state.viewYear, state.viewMonth);
  const byDay = buildOccurrences(end);

  const selectedOccs = state.selectedKey
    ? (byDay.get(state.selectedKey) || []).slice().sort((a, b) => a.time - b.time)
    : [];

  const agenda = selectedOccs.length
    ? `<ul class="agenda-list">${selectedOccs.map(agendaRowHtml).join("")}</ul>`
    : `<div class="agenda-empty">Nothing scheduled this day</div>`;

  const subCount = selectedOccs.length ? `${selectedOccs.length} item${selectedOccs.length > 1 ? "s" : ""}` : "";

  return `
    <div class="cal-head">
      <button class="cal-nav" data-cal="prev" title="Previous month">&lsaquo;</button>
      <div class="cal-month">${MONTH_NAMES[state.viewMonth]} ${state.viewYear}</div>
      <button class="cal-nav" data-cal="next" title="Next month">&rsaquo;</button>
      <button class="cal-today" data-cal="today">Today</button>
    </div>
    ${renderGrid(byDay, cells)}
    <div class="cal-legend">
      <span><span class="dot dot--upcoming"></span>Upcoming</span>
      <span><span class="dot dot--sent"></span>Sent</span>
      <span><span class="dot dot--missed"></span>Missed</span>
      <span><span class="dot dot--failed"></span>Failed</span>
      <span><span class="dot dot--recurring"></span>Recurring</span>
    </div>
    <div class="agenda">
      <div class="agenda-head">
        <div class="agenda-title">${escapeHtml(agendaTitle(state.selectedKey))}</div>
        <div class="agenda-sub">${subCount}</div>
      </div>
      ${agenda}
    </div>
  `;
}

// ── mount ────────────────────────────────────────────────────────────────────

async function reload(bodyEl: HTMLElement, myMount: number): Promise<void> {
  await fetchAll();
  if (state.mountId !== myMount) return;
  bodyEl.innerHTML = renderBody();
}

function rerender(bodyEl: HTMLElement): void {
  bodyEl.innerHTML = renderBody();
}

export async function renderScheduleView(root: HTMLElement): Promise<() => void> {
  const myMount = nextMountId++;
  state = freshState(myMount);

  render(template(), root);
  const bodyEl = root.querySelector<HTMLElement>("#schedule-body");
  if (!bodyEl) {
    console.error("[schedule] view template missing #schedule-body");
    return () => { /* no-op */ };
  }

  await reload(bodyEl, myMount);

  bodyEl.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;

    // Month nav.
    const cal = target.closest<HTMLElement>("[data-cal]");
    if (cal) {
      const which = cal.dataset.cal;
      if (which === "prev") stepMonth(-1);
      else if (which === "next") stepMonth(1);
      else if (which === "today") { state.viewYear = new Date().getFullYear(); state.viewMonth = new Date().getMonth(); state.selectedKey = todayKey(); }
      rerender(bodyEl);
      return;
    }

    // Day cell selection.
    const cell = target.closest<HTMLElement>(".cal-cell[data-day]");
    if (cell && !cell.classList.contains("other")) {
      state.selectedKey = cell.dataset.day!;
      state.reschedulingId = null;
      rerender(bodyEl);
      return;
    }

    // Row action buttons (fire/delete/reschedule).
    const btn = target.closest<HTMLButtonElement>("button[data-action]");
    if (btn) {
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      if (action && id) void handleAction(action, id, bodyEl, myMount);
      return;
    }

    // Row body click -> navigate to the chat.
    const row = target.closest<HTMLElement>(".agenda-row--nav");
    if (row) {
      const sessionId = row.dataset.navSession;
      const mode = row.dataset.navMode || "history";
      if (sessionId) {
        void invoke("open_chats_for_session", { sessionId, mode }).catch((err) =>
          console.error("[schedule] open_chats_for_session failed", err),
        );
      }
    }
  });

  let unlistenScheduled: (() => void) | null = null;
  const ev = window.__TAURI__?.event;
  if (ev?.listen) {
    const p = ev.listen("scheduled-items-changed", () => {
      void reload(bodyEl, myMount);
    });
    unlistenScheduled = () => { void p.then((u) => u()); };
  }

  return () => {
    unlistenScheduled?.();
  };
}

function stepMonth(delta: number): void {
  let m = state.viewMonth + delta;
  let y = state.viewYear;
  if (m < 0) { m = 11; y--; }
  else if (m > 11) { m = 0; y++; }
  state.viewMonth = m;
  state.viewYear = y;
}

async function handleAction(action: string, id: string, bodyEl: HTMLElement, myMount: number): Promise<void> {
  switch (action) {
    case "fire-now": {
      try {
        await invoke("schedule_fire_now", { id });
      } catch (err) {
        console.error("[schedule] schedule_fire_now failed", err);
      }
      await reload(bodyEl, myMount);
      break;
    }
    case "delete": {
      const ok = await askConfirm("Delete this scheduled item?", { confirmLabel: "Delete" });
      if (!ok) return;
      try {
        await invoke("schedule_delete", { id });
      } catch (err) {
        console.error("[schedule] schedule_delete failed", err);
      }
      await reload(bodyEl, myMount);
      break;
    }
    case "reschedule-toggle": {
      state.reschedulingId = state.reschedulingId === id ? null : id;
      rerender(bodyEl);
      break;
    }
    case "reschedule-cancel": {
      state.reschedulingId = null;
      rerender(bodyEl);
      break;
    }
    case "reschedule-confirm": {
      const input = bodyEl.querySelector<HTMLInputElement>(`input[data-reschedule-input="${CSS.escape(id)}"]`);
      const value = input?.value;
      if (!value) return;
      const local = new Date(value);
      if (isNaN(local.getTime())) return;
      const item = state.items.find((i) => i.id === id);
      if (!item) return;
      const updated: ScheduledItem = { ...item, fire_at: local.toISOString(), status: { type: "pending" } };
      try {
        await invoke("schedule_update", { item: updated });
      } catch (err) {
        console.error("[schedule] schedule_update failed", err);
      }
      state.reschedulingId = null;
      await reload(bodyEl, myMount);
      break;
    }
    default:
      break;
  }
}

function template() {
  return html`
    <div class="view view-schedule">
      <div class="view-header schedule-view-header">
        <button
          class="icon-btn burger"
          title="Menu"
          data-burger="true"
          @click=${openSidemenu}
        >
          <i class="ph ph-list"></i>
        </button>
        <h2>Schedule</h2>
        <button
          class="icon-btn"
          title="Back to Chats"
          @click=${() => showView("sessions")}
        >
          <i class="ph ph-chats"></i>
        </button>
      </div>
      <div class="view-body schedule-view-body">
        <div id="schedule-body" class="schedule-body"></div>
      </div>
    </div>
  `;
}
