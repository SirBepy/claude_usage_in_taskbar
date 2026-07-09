import { html, render } from "lit-html";
import { openSidemenu } from "../../shared/sidemenu";
import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import { showView } from "../../shared/navigation";
import { askConfirm } from "../../shared/confirm";
import { cwdToProjectName } from "../sessions/sessions-helpers";
import "./schedule.css";
import type {
  ScheduledItem,
  ExternalScheduledJob,
  Recurrence,
  Instance,
} from "../../types/ipc.generated";

interface ScheduleState {
  mountId: number;
  items: ScheduledItem[];
  external: ExternalScheduledJob[];
  /** session_id -> chat title (Instance.name), for resolving Message targets. */
  titles: Map<string, string>;
  /** id of the row currently showing its inline reschedule datetime picker. */
  reschedulingId: string | null;
  loading: boolean;
}

let state: ScheduleState = {
  mountId: 0,
  items: [],
  external: [],
  titles: new Map(),
  reschedulingId: null,
  loading: true,
};
let nextMountId = 1;

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

// ── formatting helpers ──────────────────────────────────────────────────────

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n).trimEnd()}…` : t;
}

function localTimeFromIso(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** `schedule_list_external`'s `humanTime` is a local "yyyy-MM-dd HH:mm:ss"
 * string (not RFC3339) - reparse as a local wall-clock Date. */
function dateFromHumanTime(humanTime: string): Date | null {
  const d = new Date(humanTime.replace(" ", "T"));
  return isNaN(d.getTime()) ? null : d;
}

function dayBucket(d: Date): string {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTomorrow = new Date(startOfToday.getTime() + 86400_000);
  const startOfDayAfter = new Date(startOfToday.getTime() + 2 * 86400_000);
  if (d >= startOfToday && d < startOfTomorrow) return "Today";
  if (d >= startOfTomorrow && d < startOfDayAfter) return "Tomorrow";
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function recurrenceBadge(rec: Recurrence | null): string {
  if (!rec) return "";
  let label: string;
  switch (rec.rule.type) {
    case "daily":
      label = "daily";
      break;
    case "weekly":
      label = `weekly ${rec.rule.weekdays.map((w) => WEEKDAY_LABELS[w] ?? "?").join(" ")}`;
      break;
    case "every_n_days":
      label = `every ${rec.rule.n}d`;
      break;
    default:
      label = "";
  }
  return label ? `<span class="schedule-badge schedule-badge--recurrence"><i class="ph ph-repeat"></i>${escapeHtml(label)}</span>` : "";
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

function statusPill(item: ScheduledItem): string {
  switch (item.status.type) {
    case "pending":
      return `<span class="schedule-status-pill schedule-status-pill--pending">Pending</span>`;
    case "sent":
      return `<span class="schedule-status-pill schedule-status-pill--sent">Sent</span>`;
    case "failed":
      return `<span class="schedule-status-pill schedule-status-pill--failed">Failed</span>`;
    case "missed":
      return `<span class="schedule-status-pill schedule-status-pill--missed">Missed</span>`;
    default:
      return "";
  }
}

function failureReason(item: ScheduledItem): string {
  if (item.status.type === "failed") return item.status.reason;
  return item.last_result || "";
}

/** Value for an `<input type="datetime-local">` seeded from an item's current
 * `fire_at` (UTC RFC3339), converted to the local wall-clock the input wants:
 * "yyyy-MM-ddTHH:mm". Falls back to "now" if `fire_at` is unparsable. */
function datetimeLocalValue(iso: string): string {
  const d = new Date(iso);
  const base = isNaN(d.getTime()) ? new Date() : d;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}T${pad(base.getHours())}:${pad(base.getMinutes())}`;
}

// ── row rendering ────────────────────────────────────────────────────────────

function attentionRowHtml(item: ScheduledItem): string {
  const danger = item.status.type === "failed";
  const reason = failureReason(item);
  const rescheduleOpen = state.reschedulingId === item.id;
  return `
    <li class="schedule-row schedule-row--attn ${danger ? "schedule-row--danger" : "schedule-row--warn"}" data-id="${escapeHtml(item.id)}">
      <i class="ph ${kindIconClass(item)} schedule-row-icon"></i>
      <div class="schedule-row-main">
        <div class="schedule-row-title">${escapeHtml(targetLabel(item))}</div>
        <div class="schedule-row-meta">
          ${statusPill(item)}
          <span class="schedule-time">${escapeHtml(localTimeFromIso(item.fire_at))}</span>
          ${recurrenceBadge(item.recurrence)}
          ${reason ? `<span class="schedule-reason">${escapeHtml(reason)}</span>` : ""}
        </div>
      </div>
      <div class="schedule-row-actions">
        <button class="icon-btn" data-action="fire-now" data-id="${escapeHtml(item.id)}" title="Fire now"><i class="ph ph-play"></i></button>
        <button class="icon-btn" data-action="reschedule-toggle" data-id="${escapeHtml(item.id)}" title="Reschedule"><i class="ph ph-calendar-plus"></i></button>
        <button class="icon-btn" data-action="delete" data-id="${escapeHtml(item.id)}" title="Delete"><i class="ph ph-trash"></i></button>
      </div>
      ${rescheduleOpen ? `
        <div class="schedule-reschedule-inline">
          <input type="datetime-local" data-reschedule-input="${escapeHtml(item.id)}" value="${datetimeLocalValue(item.fire_at)}">
          <button class="btn-primary" data-action="reschedule-confirm" data-id="${escapeHtml(item.id)}">Set</button>
          <button class="btn-secondary" data-action="reschedule-cancel" data-id="${escapeHtml(item.id)}">Cancel</button>
        </div>
      ` : ""}
    </li>
  `;
}

function upcomingItemRowHtml(item: ScheduledItem): string {
  return `
    <li class="schedule-row" data-id="${escapeHtml(item.id)}">
      <i class="ph ${kindIconClass(item)} schedule-row-icon"></i>
      <div class="schedule-row-main">
        <div class="schedule-row-title">${escapeHtml(targetLabel(item))}</div>
        <div class="schedule-row-meta">
          <span class="schedule-time">${escapeHtml(localTimeFromIso(item.fire_at))}</span>
          ${recurrenceBadge(item.recurrence)}
        </div>
      </div>
      <div class="schedule-row-actions">
        <button class="icon-btn" data-action="fire-now" data-id="${escapeHtml(item.id)}" title="Fire now"><i class="ph ph-play"></i></button>
        <button class="icon-btn" data-action="delete" data-id="${escapeHtml(item.id)}" title="Delete"><i class="ph ph-trash"></i></button>
      </div>
    </li>
  `;
}

function upcomingExternalRowHtml(job: ExternalScheduledJob): string {
  return `
    <li class="schedule-row schedule-row--external" data-external-id="${escapeHtml(job.id)}">
      <i class="ph ph-clock-countdown schedule-row-icon"></i>
      <div class="schedule-row-main">
        <div class="schedule-row-title">${escapeHtml(job.label)}${job.cwd ? ` &mdash; ${escapeHtml(cwdToProjectName(job.cwd))}` : ""}</div>
        <div class="schedule-row-meta">
          <span class="schedule-time">${job.fire_at ? escapeHtml((dateFromHumanTime(job.fire_at) ?? new Date()).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })) : ""}</span>
          <span class="schedule-badge schedule-badge--source"><i class="ph ph-windows-logo"></i>Task Scheduler</span>
        </div>
      </div>
    </li>
  `;
}

function pastRowHtml(item: ScheduledItem): string {
  const reason = failureReason(item);
  let deltaHtml = "";
  if (item.last_fired_at) {
    const scheduled = new Date(item.fire_at).getTime();
    const actual = new Date(item.last_fired_at).getTime();
    if (!isNaN(scheduled) && !isNaN(actual)) {
      const deltaSecs = Math.round((actual - scheduled) / 1000);
      if (deltaSecs > 5) {
        const mins = Math.round(deltaSecs / 60);
        deltaHtml = `<span class="schedule-delta">${mins >= 1 ? `${mins}m late` : `${deltaSecs}s late`}</span>`;
      }
    }
  }
  return `
    <li class="schedule-row schedule-row--past" data-id="${escapeHtml(item.id)}">
      <i class="ph ${kindIconClass(item)} schedule-row-icon"></i>
      <div class="schedule-row-main">
        <div class="schedule-row-title">${escapeHtml(targetLabel(item))}</div>
        <div class="schedule-row-meta">
          ${statusPill(item)}
          <span class="schedule-time">${item.last_fired_at ? escapeHtml(localTimeFromIso(item.last_fired_at)) : ""}</span>
          ${deltaHtml}
          ${reason ? `<span class="schedule-reason">${escapeHtml(reason)}</span>` : ""}
        </div>
      </div>
      <div class="schedule-row-actions">
        ${item.status.type === "failed" ? `<button class="icon-btn" data-action="fire-now" data-id="${escapeHtml(item.id)}" title="Retry"><i class="ph ph-arrow-clockwise"></i></button>` : ""}
      </div>
    </li>
  `;
}

// ── section assembly ────────────────────────────────────────────────────────

interface UpcomingEntry {
  time: number;
  html: string;
}

function renderBody(): string {
  if (state.loading) {
    return `<div class="schedule-loading"><span class="schedule-spinner"></span>Loading schedule&hellip;</div>`;
  }

  const needsAttention = state.items.filter((i) => i.status.type === "missed" || i.status.type === "failed");
  const pending = state.items.filter((i) => i.status.type === "pending");
  const past = state.items
    .filter((i) => i.status.type === "sent" || i.status.type === "failed" || i.status.type === "missed")
    .sort((a, b) => {
      const ta = a.last_fired_at ? new Date(a.last_fired_at).getTime() : new Date(a.created_at).getTime();
      const tb = b.last_fired_at ? new Date(b.last_fired_at).getTime() : new Date(b.created_at).getTime();
      return tb - ta;
    });

  const isEmpty = state.items.length === 0 && state.external.length === 0;

  const sections: string[] = [];

  if (needsAttention.length > 0) {
    sections.push(`
      <section class="schedule-section schedule-section--attn">
        <h3 class="schedule-section-title"><i class="ph ph-warning-circle"></i>Needs attention</h3>
        <ul class="schedule-list">${needsAttention.map(attentionRowHtml).join("")}</ul>
      </section>
    `);
  }

  if (isEmpty) {
    sections.push(`
      <div class="schedule-empty">
        <i class="ph ph-alarm"></i>
        <p>Nothing scheduled yet.</p>
        <p class="schedule-empty-hint">Scheduling lives in the chat composer &mdash; open the Send &#9662; menu to schedule a message or a new chat.</p>
      </div>
    `);
  } else {
    const entries: UpcomingEntry[] = [];
    for (const item of pending) {
      const t = new Date(item.fire_at).getTime();
      entries.push({ time: isNaN(t) ? Number.MAX_SAFE_INTEGER : t, html: upcomingItemRowHtml(item) });
    }
    for (const job of state.external) {
      const d = job.fire_at ? dateFromHumanTime(job.fire_at) : null;
      entries.push({ time: d ? d.getTime() : Number.MAX_SAFE_INTEGER, html: upcomingExternalRowHtml(job) });
    }
    entries.sort((a, b) => a.time - b.time);

    const grouped: string[] = [];
    let lastBucket = "";
    let bucketCount = 0;
    const bucketRows: string[] = [];
    const flush = () => {
      if (!lastBucket) return;
      grouped.push(`<li class="schedule-day-sep"><span>${escapeHtml(lastBucket)}</span><span class="schedule-count-chip">${bucketCount}</span></li>`);
      grouped.push(...bucketRows);
      bucketRows.length = 0;
    };
    for (const entry of entries) {
      const bucket = entry.time === Number.MAX_SAFE_INTEGER ? "Unscheduled" : dayBucket(new Date(entry.time));
      if (bucket !== lastBucket) {
        flush();
        lastBucket = bucket;
        bucketCount = 0;
      }
      bucketCount++;
      bucketRows.push(entry.html);
    }
    flush();

    sections.push(`
      <section class="schedule-section">
        <h3 class="schedule-section-title"><i class="ph ph-calendar-check"></i>Upcoming</h3>
        <ul class="schedule-list">${grouped.length ? grouped.join("") : `<li class="schedule-empty-row">Nothing upcoming</li>`}</ul>
      </section>
    `);

    sections.push(`
      <details class="schedule-section schedule-section--past">
        <summary class="schedule-section-title"><i class="ph ph-clock-counter-clockwise"></i>Past (${past.length})</summary>
        <ul class="schedule-list">${past.length ? past.map(pastRowHtml).join("") : `<li class="schedule-empty-row">No past items</li>`}</ul>
      </details>
    `);
  }

  sections.push(`
    <section class="schedule-section schedule-section--cloud">
      <h3 class="schedule-section-title"><i class="ph ph-cloud"></i>Cloud cron jobs</h3>
      <p class="schedule-muted">No data path to claude.ai cron jobs yet.</p>
    </section>
  `);

  return sections.join("");
}

// ── mount ────────────────────────────────────────────────────────────────────

async function reload(bodyEl: HTMLElement, myMount: number): Promise<void> {
  await fetchAll();
  if (state.mountId !== myMount) return;
  bodyEl.innerHTML = renderBody();
}

export async function renderScheduleView(root: HTMLElement): Promise<() => void> {
  const myMount = nextMountId++;
  state = {
    mountId: myMount,
    items: [],
    external: [],
    titles: new Map(),
    reschedulingId: null,
    loading: true,
  };

  render(template(), root);
  const bodyEl = root.querySelector<HTMLElement>("#schedule-body");
  if (!bodyEl) {
    console.error("[schedule] view template missing #schedule-body");
    return () => { /* no-op */ };
  }

  await reload(bodyEl, myMount);

  bodyEl.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    if (!action || !id) return;
    void handleAction(action, id, bodyEl, myMount);
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
      bodyEl.innerHTML = renderBody();
      break;
    }
    case "reschedule-cancel": {
      state.reschedulingId = null;
      bodyEl.innerHTML = renderBody();
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
      const updated: ScheduledItem = {
        ...item,
        fire_at: local.toISOString(),
        status: { type: "pending" },
      };
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
      <div class="view-header">
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
