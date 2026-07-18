// Docked HTML preview panel (ai_todo 138, frontend chunk).
//
// The daemon owns one global preview timeline: terminal Claude (curl to
// `/hooks/preview`) and the in-app chat AI both push HTML snapshots to it. A
// same-slug push replaces the live entry in place (version++, same id); a
// new/absent slug appends a new snapshot. This module renders that store —
// live latest + a history rail — as a dockable panel.
//
// `renderPreview(root, { mode })` takes a `mode` so a future pop-out OS
// window can reuse this exact renderer (ai_todo 138's deferred follow-up);
// only `mode: "panel"` is wired up today, per the frontend-chunk scope.
//
// Live updates arrive two ways, per `project_daemon_notifier_broadcast_lossy`:
// a `preview` daemon-notifier broadcast (fast, but can be dropped under
// backpressure) AND an explicit `list_previews` refetch on panel open/window
// focus (authoritative, never skipped).

import { invoke } from "../../shared/ipc";
import { getTransport, type Unlisten } from "../../shared/transport";
import { escapeHtml } from "../../shared/escape-html";
import { formatRelativeMinutes } from "../../shared/formatters";
import type { PreviewMeta, PreviewSnapshot } from "../../types/ipc.generated";

export type PreviewMode = "panel" | "window";
type DeviceWidth = "desktop" | "tablet" | "phone";

export interface PreviewController {
  toggle(): void;
  open(snapshotId?: string): void;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}

// ── Persistence (dock-open + panel width only — the real cross-reopen
// behavior per the spec; device-width and auto-refresh stay in-memory). Same
// localStorage + try/catch shape as state.ts's LS_LAST_SELECTED. ──────────
const LS_OPEN_KEY = "cc_preview_panel_open";
const LS_WIDTH_KEY = "cc_preview_panel_width";
const DEFAULT_WIDTH = 420;
const MIN_WIDTH = 320;
const MAX_WIDTH = 720;
const LIVE_PULSE_MS = 5000;
const PUSH_BADGE_MS = 8000;

function loadOpen(): boolean {
  try {
    return localStorage.getItem(LS_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function saveOpen(open: boolean): void {
  try {
    localStorage.setItem(LS_OPEN_KEY, open ? "1" : "0");
  } catch {
    /* quota or storage disabled */
  }
}

function loadWidth(): number {
  try {
    const raw = localStorage.getItem(LS_WIDTH_KEY);
    const n = raw ? parseInt(raw, 10) : NaN;
    if (Number.isFinite(n)) return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n));
  } catch {
    /* ignore */
  }
  return DEFAULT_WIDTH;
}

function saveWidth(px: number): void {
  try {
    localStorage.setItem(LS_WIDTH_KEY, String(Math.round(px)));
  } catch {
    /* ignore */
  }
}

/** Past-tense relative time ("just now" / "5m ago" / "2h 3m ago") built on
 * the shared forward-looking h/m breakdown (`formatRelativeMinutes`) so the
 * math stays in one place; only the wording differs for a past timestamp. */
function agoText(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  return formatRelativeMinutes(ms).replace(/^in /, "") + " ago";
}

function sourceDotClass(source: string): string {
  return source === "terminal" ? "pv-dot-terminal" : "pv-dot-chat";
}

/** AI-pushed HTML may be a bare fragment; wrap it in minimal boilerplate
 * before it becomes the iframe's srcdoc document. */
function wrapFragmentIfNeeded(html: string): string {
  if (/<html[\s>]/i.test(html) || /<body[\s>]/i.test(html)) return html;
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`;
}

// Inner document CSP. Locked decision (Joe, 2026-06-26): do NOT hard-block
// network — a preview may legitimately fetch data. Left permissive on
// script/style/connect so "look-right rendering" (inline <script>, CDN
// fetches) isn't broken; the REAL isolation boundary is the iframe's
// `sandbox="allow-scripts"` with no `allow-same-origin` (opaque origin —
// scripts run but can't reach the parent DOM, storage, or IPC).
const INNER_CSP_META =
  `<meta http-equiv="Content-Security-Policy" content="default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; img-src * data: blob:; font-src * data:;">`;

function buildSrcdoc(html: string): string {
  const wrapped = wrapFragmentIfNeeded(html);
  if (/<head[^>]*>/i.test(wrapped)) {
    return wrapped.replace(/<head[^>]*>/i, (m) => `${m}${INNER_CSP_META}`);
  }
  if (/<html[^>]*>/i.test(wrapped)) {
    return wrapped.replace(/<html[^>]*>/i, (m) => `${m}<head>${INNER_CSP_META}</head>`);
  }
  return `${INNER_CSP_META}${wrapped}`;
}

class PreviewPanel implements PreviewController {
  private root: HTMLElement;
  private mode: PreviewMode;
  private snapshots: PreviewMeta[] = [];
  private selected: PreviewSnapshot | null = null;
  private deviceWidth: DeviceWidth = "desktop";
  private autoRefresh = true;
  private openState: boolean;
  private width: number;
  private unlistenPreview: Unlisten | null = null;
  private pulseTimer: ReturnType<typeof setTimeout> | null = null;
  private badgeTimer: ReturnType<typeof setTimeout> | null = null;
  private badgeEl: HTMLButtonElement | null = null;
  private focusHandler: (() => void) | null = null;
  private resizeCleanup: (() => void) | null = null;

  constructor(root: HTMLElement, mode: PreviewMode) {
    this.root = root;
    this.mode = mode;
    this.width = loadWidth();
    this.openState = loadOpen();

    this.renderShell();
    this.wireEvents();
    this.resizeCleanup = wireResizeHandle(this.root, (px) => {
      this.width = px;
      saveWidth(px);
    });
    void this.subscribeLive();

    this.focusHandler = () => {
      if (this.openState) void this.refreshList();
    };
    window.addEventListener("focus", this.focusHandler);

    if (this.openState) {
      this.root.hidden = false;
      void this.refreshList();
    } else {
      this.root.hidden = true;
      this.renderHeaderEmpty();
      this.renderCanvasEmpty();
    }
  }

  // ── Public controller API ────────────────────────────────────────────────

  toggle(): void {
    if (this.openState) this.close();
    else this.open();
  }

  open(snapshotId?: string): void {
    this.openState = true;
    saveOpen(true);
    this.root.hidden = false;
    void this.refreshList(snapshotId ? { selectId: snapshotId } : {});
  }

  close(): void {
    this.openState = false;
    saveOpen(false);
    this.root.hidden = true;
  }

  isOpen(): boolean {
    return this.openState;
  }

  destroy(): void {
    if (this.unlistenPreview) {
      try { this.unlistenPreview(); } catch { /* ignore */ }
      this.unlistenPreview = null;
    }
    if (this.pulseTimer) { clearTimeout(this.pulseTimer); this.pulseTimer = null; }
    if (this.badgeTimer) { clearTimeout(this.badgeTimer); this.badgeTimer = null; }
    if (this.focusHandler) {
      window.removeEventListener("focus", this.focusHandler);
      this.focusHandler = null;
    }
    if (this.resizeCleanup) { this.resizeCleanup(); this.resizeCleanup = null; }
    this.badgeEl?.remove();
    this.badgeEl = null;
  }

  // ── Data ─────────────────────────────────────────────────────────────────

  private async refreshList(opts: { selectId?: string } = {}): Promise<void> {
    try {
      const list = await invoke<PreviewMeta[]>("list_previews");
      this.snapshots = Array.isArray(list) ? list : [];
    } catch (err) {
      console.error("[preview-panel] list_previews failed", err);
    }
    this.renderRail();

    const first = this.snapshots[0];
    if (!first) {
      this.selected = null;
      this.renderHeaderEmpty();
      this.renderCanvasEmpty();
      return;
    }
    const targetId = opts.selectId ?? this.selected?.id ?? first.id;
    const stillExists = this.snapshots.some((s) => s.id === targetId);
    await this.selectSnapshot(stillExists ? targetId : first.id);
  }

  private async selectSnapshot(id: string, opts: { pulse?: boolean } = {}): Promise<void> {
    try {
      this.selected = await invoke<PreviewSnapshot>("get_preview", { id });
    } catch (err) {
      console.error("[preview-panel] get_preview failed", err);
      return;
    }
    this.renderHeader();
    this.renderIframe();
    this.renderRail();
    if (opts.pulse) this.pulseLive();
  }

  /** `preview` notifier broadcast handler — the fast path. Always keeps the
   * rail metadata current; only moves the visible iframe when auto-refresh is
   * on, nothing is selected yet, or the push landed on the snapshot already
   * being viewed (so a manual look at an older history entry isn't yanked out
   * from under the user). While the panel is closed, surfaces the lighter-
   * weight "preview pushed" badge instead (see class docs on why not the
   * transcript tool-chip path). */
  private onLivePush(meta: PreviewMeta | undefined): void {
    if (!meta) return;
    const idx = this.snapshots.findIndex((s) => s.id === meta.id);
    if (idx >= 0) this.snapshots[idx] = meta;
    else this.snapshots.unshift(meta);

    if (!this.openState) {
      this.showPushBadge(meta);
      return;
    }
    this.renderRail();
    const shouldFollow = this.autoRefresh || !this.selected || this.selected.id === meta.id;
    if (shouldFollow) void this.selectSnapshot(meta.id, { pulse: true });
  }

  private async subscribeLive(): Promise<void> {
    try {
      this.unlistenPreview = await getTransport().listen<{ snapshot: PreviewMeta }>(
        "preview",
        (payload) => this.onLivePush(payload?.snapshot),
      );
    } catch (err) {
      console.warn("[preview-panel] listen(preview) failed", err);
    }
  }

  // ── "Preview pushed" badge (lighter-weight substitute for the in-chat tool
  // chip — see class docs). Clicking it opens the panel on that snapshot. ──

  private showPushBadge(meta: PreviewMeta): void {
    if (!this.badgeEl) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "pv-push-badge";
      el.addEventListener("click", () => {
        const id = el.dataset.snapId;
        this.dismissBadge();
        this.open(id);
      });
      document.body.appendChild(el);
      this.badgeEl = el;
    }
    this.badgeEl.dataset.snapId = meta.id;
    this.badgeEl.innerHTML =
      `<i class="ph-fill ph-monitor-play"></i> Preview pushed: <b>${escapeHtml(meta.slug)}</b> <small>· v${meta.version}</small>`;
    this.badgeEl.classList.add("show");
    if (this.badgeTimer) clearTimeout(this.badgeTimer);
    this.badgeTimer = setTimeout(() => this.dismissBadge(), PUSH_BADGE_MS);
  }

  private dismissBadge(): void {
    this.badgeEl?.classList.remove("show");
    if (this.badgeTimer) { clearTimeout(this.badgeTimer); this.badgeTimer = null; }
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  private openInBrowser(): void {
    if (!this.selected) return;
    // No dedicated backend "open preview in browser" endpoint exists (the
    // hook server only has a write route) — a self-contained data: URL is the
    // simplest escape hatch that needs no new IPC surface. Payload is already
    // capped (~2MB) daemon-side, well within what a data: URL can carry.
    const dataUrl = "data:text/html;charset=utf-8," + encodeURIComponent(this.selected.html);
    void invoke("open_external", { url: dataUrl }).catch((err) =>
      console.error("[preview-panel] open_external failed", err),
    );
  }

  private copyHtml(): void {
    if (!this.selected) return;
    void navigator.clipboard.writeText(this.selected.html).catch((err) =>
      console.error("[preview-panel] clipboard write failed", err),
    );
  }

  private setDeviceWidth(w: DeviceWidth): void {
    this.deviceWidth = w;
    this.root.querySelectorAll<HTMLElement>(".pv-seg-btn").forEach((b) => {
      b.classList.toggle("on", b.dataset.w === w);
    });
    const frame = this.root.querySelector<HTMLElement>(".pv-frame");
    if (frame) frame.dataset.w = w;
  }

  private pulseLive(): void {
    const liveEl = this.root.querySelector<HTMLElement>(".pv-live");
    if (!liveEl) return;
    liveEl.classList.add("pv-just-pushed");
    if (this.pulseTimer) clearTimeout(this.pulseTimer);
    this.pulseTimer = setTimeout(() => liveEl.classList.remove("pv-just-pushed"), LIVE_PULSE_MS);
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  private renderShell(): void {
    this.root.innerHTML = `
      <div class="preview-panel" data-mode="${this.mode}" style="width:${this.width}px">
        <div class="pv-resize-handle" data-resize title="Drag to resize"></div>
        <header class="pv-head">
          <span class="pv-title"><i class="ph ph-monitor-play"></i><span class="pv-name">No previews yet</span><span class="pv-ver"></span></span>
          <span class="pv-badge" hidden></span>
          <span class="pv-live" hidden><span class="pv-pulse"></span>LIVE</span>
          <span class="pv-grow"></span>
          <button type="button" class="pv-icon-btn" data-act="refresh" title="Refresh"><i class="ph ph-arrow-clockwise"></i></button>
          <button type="button" class="pv-icon-btn" data-act="open-browser" title="Open in browser"><i class="ph ph-arrow-square-out"></i></button>
          <button type="button" class="pv-icon-btn" data-act="copy" title="Copy HTML"><i class="ph ph-copy"></i></button>
          <button type="button" class="pv-icon-btn" data-act="popout" title="Pop-out window (coming soon)" disabled><i class="ph ph-arrows-out-simple"></i></button>
          <button type="button" class="pv-icon-btn" data-act="close" title="Close panel"><i class="ph ph-x"></i></button>
        </header>
        <div class="pv-sub">
          <div class="pv-seg">
            <button type="button" class="pv-seg-btn on" data-w="desktop"><i class="ph ph-monitor"></i>Desktop</button>
            <button type="button" class="pv-seg-btn" data-w="tablet"><i class="ph ph-device-tablet"></i>Tablet</button>
            <button type="button" class="pv-seg-btn" data-w="phone"><i class="ph ph-device-mobile"></i>Phone</button>
          </div>
          <label class="pv-autorefresh"><input type="checkbox" checked><span>Auto-refresh</span></label>
        </div>
        <div class="pv-body">
          <div class="pv-rail" data-rail><div class="pv-rail-lbl">History</div></div>
          <div class="pv-canvas"></div>
        </div>
      </div>
    `;
    this.renderCanvasEmpty();
  }

  private renderHeader(): void {
    if (!this.selected) return;
    const nameEl = this.root.querySelector<HTMLElement>(".pv-name");
    const verEl = this.root.querySelector<HTMLElement>(".pv-ver");
    const badgeEl = this.root.querySelector<HTMLElement>(".pv-badge");
    const liveEl = this.root.querySelector<HTMLElement>(".pv-live");
    const liveId = this.snapshots[0]?.id;

    if (nameEl) nameEl.textContent = this.selected.slug;
    if (verEl) verEl.textContent = ` · v${this.selected.version}`;
    if (badgeEl) {
      badgeEl.hidden = false;
      badgeEl.innerHTML = `<span class="pv-dot ${sourceDotClass(this.selected.source)}"></span>${escapeHtml(this.selected.source)}`;
    }
    if (liveEl) liveEl.hidden = liveId !== this.selected.id;
  }

  private renderHeaderEmpty(): void {
    const nameEl = this.root.querySelector<HTMLElement>(".pv-name");
    const verEl = this.root.querySelector<HTMLElement>(".pv-ver");
    const badgeEl = this.root.querySelector<HTMLElement>(".pv-badge");
    const liveEl = this.root.querySelector<HTMLElement>(".pv-live");
    if (nameEl) nameEl.textContent = "No previews yet";
    if (verEl) verEl.textContent = "";
    if (badgeEl) badgeEl.hidden = true;
    if (liveEl) liveEl.hidden = true;
  }

  private renderIframe(): void {
    if (!this.selected) return;
    const canvas = this.root.querySelector<HTMLElement>(".pv-canvas");
    if (!canvas) return;
    canvas.innerHTML = `<div class="pv-frame" data-w="${this.deviceWidth}"><iframe class="pv-iframe" sandbox="allow-scripts"></iframe></div>`;
    const iframe = canvas.querySelector<HTMLIFrameElement>(".pv-iframe");
    if (iframe) iframe.srcdoc = buildSrcdoc(this.selected.html);
  }

  private renderCanvasEmpty(): void {
    const canvas = this.root.querySelector<HTMLElement>(".pv-canvas");
    if (!canvas) return;
    canvas.innerHTML = `
      <div class="pv-empty">
        <i class="ph ph-monitor-play"></i>
        <p>No previews yet</p>
        <p class="pv-empty-hint">Push one via <code>/preview</code>, or ask the chat AI to show you something.</p>
      </div>
    `;
  }

  private renderRail(): void {
    const rail = this.root.querySelector<HTMLElement>("[data-rail]");
    if (!rail) return;
    if (this.snapshots.length === 0) {
      rail.innerHTML = `<div class="pv-rail-lbl">History</div>`;
      return;
    }
    const liveId = this.snapshots[0]?.id;
    const rows = this.snapshots.map((s) => {
      const sel = this.selected?.id === s.id ? " sel" : "";
      const liveTag = s.id === liveId ? ` <span class="pv-live-tag">LIVE</span>` : "";
      return `<div class="pv-snap${sel}" data-id="${escapeHtml(s.id)}">
        <div class="pv-snap-title">${escapeHtml(s.title || s.slug)}${liveTag}</div>
        <div class="pv-snap-meta"><span class="pv-dot ${sourceDotClass(s.source)}"></span>v${s.version} · ${agoText(s.created_at)}</div>
      </div>`;
    }).join("");
    rail.innerHTML = `<div class="pv-rail-lbl">History</div>${rows}`;
  }

  // ── Event wiring ─────────────────────────────────────────────────────────

  private wireEvents(): void {
    this.root.addEventListener("click", (e) => this.onClick(e));
    this.root.addEventListener("change", (e) => {
      const target = e.target as HTMLElement;
      if (target.matches(".pv-autorefresh input")) {
        this.autoRefresh = (target as HTMLInputElement).checked;
      }
    });
  }

  private onClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;

    const actBtn = target.closest<HTMLElement>("[data-act]");
    if (actBtn) {
      switch (actBtn.dataset.act) {
        case "refresh": void this.refreshList(); return;
        case "open-browser": this.openInBrowser(); return;
        case "copy": this.copyHtml(); return;
        case "close": this.close(); return;
        default: return; // "popout" is disabled (deferred pop-out window)
      }
    }

    const segBtn = target.closest<HTMLElement>(".pv-seg-btn");
    if (segBtn?.dataset.w) {
      this.setDeviceWidth(segBtn.dataset.w as DeviceWidth);
      return;
    }

    const snap = target.closest<HTMLElement>(".pv-snap");
    if (snap?.dataset.id) {
      void this.selectSnapshot(snap.dataset.id);
    }
  }
}

// Resize-drag wiring is kept out of the class body above as a free function
// bound in the constructor, mirroring the rest of the panel's DOM-query style
// (queries `.preview-panel` / `[data-resize]` fresh, no cached refs needed
// beyond the drag's own closure).
function wireResizeHandle(root: HTMLElement, onCommit: (px: number) => void): () => void {
  const handle = root.querySelector<HTMLElement>("[data-resize]");
  const panel = root.querySelector<HTMLElement>(".preview-panel");
  if (!handle || !panel) return () => {};

  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  const onMove = (e: MouseEvent) => {
    if (!dragging) return;
    const delta = startX - e.clientX; // dragging left (toward the chat) grows the panel
    const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta));
    panel.style.width = `${next}px`;
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    const finalWidth = parseInt(panel.style.width, 10);
    if (Number.isFinite(finalWidth)) onCommit(finalWidth);
  };
  const onDown = (e: MouseEvent) => {
    dragging = true;
    startX = e.clientX;
    startWidth = panel.getBoundingClientRect().width;
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    e.preventDefault();
  };
  handle.addEventListener("mousedown", onDown);

  return () => {
    handle.removeEventListener("mousedown", onDown);
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
}

/**
 * Shared preview renderer. `mode: "panel"` is the only wired-up variant today
 * (docked sibling of `.session-pane`); `"window"` is reserved for the
 * deferred pop-out OS window follow-up so that surface can mount this exact
 * component later with zero renderer changes.
 */
export function renderPreview(root: HTMLElement, opts: { mode: PreviewMode }): PreviewController {
  return new PreviewPanel(root, opts.mode);
}
