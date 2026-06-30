/**
 * The four inline popover subsystems extracted from session-statusbar.ts.
 * Each class owns its open/close state, HTML generation, DOM state, and
 * event-listener wiring. SessionStatusbar delegates to these.
 */

import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import { EFFORTS } from "../../shared/effort-presets";
import { formatTokenCount } from "../../shared/chat/turn-chips";
import type { AiTodoEntry, ChatDrain } from "../../types/ipc.generated";
import { drainCache } from "./session-statusbar-helpers";

// ─────────────────────────────────── Drain ─────────────────────────────────

export class DrainPopover {
  drain: ChatDrain | null = null;
  private inflight = false;
  private el: HTMLElement | null = null;
  private cleanup: (() => void) | null = null;

  get isOpen(): boolean { return this.el !== null; }

  async refresh(sid: string, rerender: () => void, reanchor: () => void): Promise<void> {
    if (this.inflight) return;
    this.inflight = true;
    try {
      const d = await invoke<ChatDrain | null>("chat_drain", { sessionId: sid });
      if (d) {
        this.drain = d;
        drainCache.set(sid, d);
        rerender();
        if (this.el) reanchor();
      }
    } catch { /* transient */ }
    finally { this.inflight = false; }
  }

  renderChip(animClass: (key: string) => string): string {
    const d = this.drain;
    if (!d) {
      return `<span class="sb-chip sb-drain sb-drain-btn muted${animClass("drain")}" role="button" tabindex="0" aria-label="Token drain (loading)" title="Share of a 5h session this chat has used (loading)"><i class="ph ph-drop"></i>··%</span>`;
    }
    if (d.fiveHourPct === null) {
      const label = "No usage data yet to compute this chat's share. Click for the token rundown.";
      return `<span class="sb-chip sb-drain sb-drain-btn muted${animClass("drain")}" role="button" tabindex="0" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"><i class="ph ph-drop"></i>—%</span>`;
    }
    const five = Math.round(d.fiveHourPct);
    const week = Math.round(d.weeklyPct ?? 0);
    const cls = d.fiveHourPct >= 80 ? " danger" : d.fiveHourPct >= 50 ? " warn" : "";
    const label = `This chat is ${five}% of your current 5h session and ${week}% of the week. Click for a per-message rundown.`;
    return `<span class="sb-chip sb-drain sb-drain-btn${cls}${animClass("drain")}" role="button" tabindex="0" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"><i class="ph ph-drop"></i>${five}% · ${week}%w</span>`;
  }

  /** Body-appended, positioned off the drain chip anchor. Rebuilds in-place when called while open. */
  open(anchor: HTMLElement): void {
    this.cleanup?.();
    this.cleanup = null;
    this.el?.remove();

    const pop = document.createElement("div");
    pop.className = "sb-drain-popover";
    pop.innerHTML = this.buildHtml();
    document.body.appendChild(pop);
    this.el = pop;

    const rect = anchor.getBoundingClientRect();
    const maxLeft = window.innerWidth - pop.offsetWidth - 8;
    pop.style.left = `${Math.max(8, Math.min(rect.left, maxLeft))}px`;
    const below = window.innerHeight - rect.bottom;
    if (below >= pop.offsetHeight + 8 || below >= rect.top) {
      pop.style.top = `${rect.bottom + 4}px`;
    } else {
      pop.style.bottom = `${window.innerHeight - rect.top + 4}px`;
    }

    const onOutside = (e: MouseEvent) => {
      if (!pop.contains(e.target as Node) && !anchor.contains(e.target as Node)) {
        this.close();
      }
    };
    setTimeout(() => document.addEventListener("click", onOutside), 0);
    this.cleanup = () => document.removeEventListener("click", onOutside);
  }

  close(): void {
    this.cleanup?.();
    this.cleanup = null;
    this.el?.remove();
    this.el = null;
  }

  toggle(anchor: HTMLElement): void {
    if (this.el) this.close();
    else this.open(anchor);
  }

  private buildHtml(): string {
    const d = this.drain;
    if (!d) return `<div class="sb-drain-empty">No drain data yet</div>`;
    const pct = (v: number | null): string => (v === null ? "—" : `${Math.round(v)}%`);
    const tokens = formatTokenCount(Number(d.tokens), { decimals: 1 });
    const header = `
      <div class="sb-drain-header">
        <span class="sb-drain-stat"><span class="sb-drain-stat-val">${pct(d.fiveHourPct)}</span><span class="sb-drain-stat-lbl">of your 5h session</span></span>
        <span class="sb-drain-stat"><span class="sb-drain-stat-val">${pct(d.weeklyPct)}</span><span class="sb-drain-stat-lbl">of the week</span></span>
      </div>
      <div class="sb-drain-secondary"><i class="ph ph-coins"></i>${escapeHtml(tokens)} tokens used</div>`;
    const rows = d.messages.length === 0
      ? `<div class="sb-drain-empty">No message breakdown yet</div>`
      : d.messages.map((m) => {
          const flag = m.expensive ? ' <i class="ph ph-warning sb-drain-flag"></i>' : "";
          const expCls = m.expensive ? " expensive" : "";
          const tok = formatTokenCount(Number(m.tokens), { decimals: 1 });
          return `<div class="sb-drain-row${expCls}" title="${escapeHtml(m.preview)}"><span class="sb-drain-idx">#${m.index}</span><span class="sb-drain-preview">${escapeHtml(m.preview)}</span>${flag}<span class="sb-drain-tokens">${escapeHtml(tok)} tok</span></div>`;
        }).join("");
    return `${header}<div class="sb-drain-list">${rows}</div>`;
  }
}

// ─────────────────────────────── Branch ────────────────────────────────────

export interface BranchEntry { name: string; current: boolean; short_sha: string | null; upstream: string | null; }

export class BranchPopover {
  private el: HTMLElement | null = null;
  private cleanup: (() => void) | null = null;

  get isOpen(): boolean { return this.el !== null; }

  open(anchor: HTMLElement, branches: BranchEntry[]): void {
    this.cleanup?.();
    this.cleanup = null;
    this.el?.remove();
    const pop = document.createElement("div");
    pop.className = "sb-git-popover sb-branch-popover";
    pop.innerHTML = this.buildHtml(branches);
    document.body.appendChild(pop);
    this.el = pop;
    this.reposition(anchor);
    const onOutside = (e: MouseEvent) => {
      if (!pop.contains(e.target as Node) && !anchor.contains(e.target as Node)) this.close();
    };
    setTimeout(() => document.addEventListener("click", onOutside), 0);
    this.cleanup = () => document.removeEventListener("click", onOutside);
  }

  close(): void {
    this.cleanup?.();
    this.cleanup = null;
    this.el?.remove();
    this.el = null;
  }

  toggle(anchor: HTMLElement, branches: BranchEntry[]): void {
    if (this.el) this.close();
    else this.open(anchor, branches);
  }

  reanchor(anchor: HTMLElement): void { this.reposition(anchor); }

  private reposition(anchor: HTMLElement): void {
    if (!this.el) return;
    const rect = anchor.getBoundingClientRect();
    const maxLeft = window.innerWidth - this.el.offsetWidth - 8;
    this.el.style.left = `${Math.max(8, Math.min(rect.left, maxLeft))}px`;
    const below = window.innerHeight - rect.bottom;
    if (below >= this.el.offsetHeight + 8 || below >= rect.top) {
      this.el.style.top = `${rect.bottom + 4}px`;
      this.el.style.bottom = "";
    } else {
      this.el.style.bottom = `${window.innerHeight - rect.top + 4}px`;
      this.el.style.top = "";
    }
  }

  private buildHtml(branches: BranchEntry[]): string {
    const header = `<div class="sb-git-pop-header"><i class="ph ph-git-branch"></i>Recent branches</div>`;
    if (branches.length === 0) return `${header}<div class="sb-git-pop-empty">No branches found</div>`;
    const rows = branches.map((b) => {
      const check = b.current ? `<i class="ph ph-check sb-git-pop-check"></i>` : `<span class="sb-git-pop-check-pad"></span>`;
      const sha = b.short_sha ? `<span class="sb-git-pop-sha">${escapeHtml(b.short_sha)}</span>` : "";
      const up = b.upstream ? `<span class="sb-git-pop-upstream">${escapeHtml(b.upstream)}</span>` : "";
      return `<div class="sb-git-pop-row${b.current ? " current" : ""}">${check}<span class="sb-git-pop-name">${escapeHtml(b.name)}</span>${sha}${up}</div>`;
    }).join("");
    return `${header}<div class="sb-git-pop-list">${rows}</div>`;
  }
}

// ─────────────────────────────── Commits ───────────────────────────────────

export interface CommitEntry { short_sha: string; message: string; }
export interface CommitSync { ahead: CommitEntry[]; behind: CommitEntry[]; has_upstream: boolean; }

export class CommitsPopover {
  private el: HTMLElement | null = null;
  private cleanup: (() => void) | null = null;

  get isOpen(): boolean { return this.el !== null; }

  open(anchor: HTMLElement, sync: CommitSync): void {
    this.cleanup?.();
    this.cleanup = null;
    this.el?.remove();
    const pop = document.createElement("div");
    pop.className = "sb-git-popover sb-commits-popover";
    pop.innerHTML = this.buildHtml(sync);
    document.body.appendChild(pop);
    this.el = pop;
    this.reposition(anchor);
    const onOutside = (e: MouseEvent) => {
      if (!pop.contains(e.target as Node) && !anchor.contains(e.target as Node)) this.close();
    };
    setTimeout(() => document.addEventListener("click", onOutside), 0);
    this.cleanup = () => document.removeEventListener("click", onOutside);
  }

  close(): void {
    this.cleanup?.();
    this.cleanup = null;
    this.el?.remove();
    this.el = null;
  }

  toggle(anchor: HTMLElement, sync: CommitSync): void {
    if (this.el) this.close();
    else this.open(anchor, sync);
  }

  reanchor(anchor: HTMLElement): void { this.reposition(anchor); }

  private reposition(anchor: HTMLElement): void {
    if (!this.el) return;
    const rect = anchor.getBoundingClientRect();
    const maxLeft = window.innerWidth - this.el.offsetWidth - 8;
    this.el.style.left = `${Math.max(8, Math.min(rect.left, maxLeft))}px`;
    const below = window.innerHeight - rect.bottom;
    if (below >= this.el.offsetHeight + 8 || below >= rect.top) {
      this.el.style.top = `${rect.bottom + 4}px`;
      this.el.style.bottom = "";
    } else {
      this.el.style.bottom = `${window.innerHeight - rect.top + 4}px`;
      this.el.style.top = "";
    }
  }

  private buildHtml(sync: CommitSync): string {
    if (!sync.has_upstream) {
      return `<div class="sb-git-pop-empty">No upstream configured for this branch</div>`;
    }
    const { ahead, behind } = sync;
    if (ahead.length === 0 && behind.length === 0) {
      return `<div class="sb-git-pop-empty"><i class="ph ph-check-circle"></i> Up to date with upstream</div>`;
    }
    const parts: string[] = [];
    if (ahead.length > 0) {
      const rows = ahead.map((c) =>
        `<div class="sb-git-pop-commit"><span class="sb-git-pop-sha">${escapeHtml(c.short_sha)}</span><span class="sb-git-pop-msg">${escapeHtml(c.message)}</span></div>`
      ).join("");
      parts.push(`<div class="sb-git-pop-section ahead"><i class="ph ph-arrow-up"></i>Outgoing <span class="sb-git-pop-count">${ahead.length}</span></div><div class="sb-git-pop-list">${rows}</div>`);
    }
    if (behind.length > 0) {
      const rows = behind.map((c) =>
        `<div class="sb-git-pop-commit"><span class="sb-git-pop-sha">${escapeHtml(c.short_sha)}</span><span class="sb-git-pop-msg">${escapeHtml(c.message)}</span></div>`
      ).join("");
      parts.push(`<div class="sb-git-pop-section behind"><i class="ph ph-arrow-down"></i>Incoming <span class="sb-git-pop-count">${behind.length}</span></div><div class="sb-git-pop-list">${rows}</div>`);
    }
    return parts.join("");
  }
}

// ─────────────────────────────── AI Todos ──────────────────────────────────

export class AiTodosPopover {
  isOpen = false;
  files: AiTodoEntry[] = [];
  loaded = false;

  async refresh(cwd: string, rerender: () => void): Promise<void> {
    try {
      const files = await invoke<AiTodoEntry[]>("list_ai_todos", { cwd });
      this.files = files;
      this.loaded = true;
      rerender();
    } catch { /* transient */ }
  }

  renderChip(cwd: string | null, animClass: (key: string) => string): string {
    if (!cwd) return "";
    if (!this.loaded) {
      return `<span class="sb-chip sb-skeleton sb-ai-todos" data-skeleton="ai_todos" style="min-width:55px"><i class="ph ph-check-square"></i><span class="sb-skel-bar"></span></span>`;
    }
    const n = this.files.length;
    if (n === 0) return "";
    return `<span class="sb-chip sb-ai-todos sb-ai-todos-btn${animClass("ai_todos")}" role="button" tabindex="0" title="${n} AI todo${n === 1 ? "" : "s"} in .for_bepy/ai_todos"><i class="ph ph-check-square"></i>${n} todo${n === 1 ? "" : "s"}</span>`;
  }

  html(): string {
    if (!this.isOpen || this.files.length === 0) return "";
    return `
      <div class="sb-ai-todos-popover">
        <div class="sb-ai-todos-popover-header">AI Todos (${this.files.length})</div>
        <div class="sb-ai-todos-popover-list">
          ${this.files.map((f) => `<div class="sb-ai-todos-popover-file" role="button" tabindex="0" data-path="${escapeHtml(f.path)}">${escapeHtml(f.name)}</div>`).join("")}
        </div>
      </div>
    `;
  }

  wire(container: HTMLElement, rerender: () => void): void {
    container.querySelectorAll<HTMLElement>(".sb-ai-todos-popover-file").forEach((el) => {
      el.addEventListener("click", () => {
        const p = el.dataset.path;
        if (p) void invoke<void>("open_in_editor", { path: p });
      });
    });
    if (!this.isOpen) return;
    const close = (e: MouseEvent) => {
      if (!container.contains(e.target as Node)) {
        this.isOpen = false;
        rerender();
        document.removeEventListener("click", close);
      }
    };
    setTimeout(() => document.addEventListener("click", close), 0);
  }
}

// ─────────────────────────────── Effort ────────────────────────────────────

export class EffortPopover {
  isOpen = false;

  html(effort: string): string {
    if (!this.isOpen) return "";
    const effortIdx = Math.max(0, EFFORTS.indexOf(effort as typeof EFFORTS[number]));
    return `
      <div class="sb-effort-popover">
        <div class="sb-effort-popover-label">Effort</div>
        <input type="range" class="sb-effort-slider" min="0" max="${EFFORTS.length - 1}" step="1" value="${effortIdx}">
        <div class="sb-effort-stops">
          ${EFFORTS.map((e, i) => `<span class="sb-effort-stop${i === effortIdx ? " active" : ""}">${escapeHtml(e)}</span>`).join("")}
        </div>
      </div>
    `;
  }

  wire(
    container: HTMLElement,
    sessionId: string | null,
    onEffortChange: ((effort: string) => void) | null,
    onSet: (effort: string) => void,
    rerender: () => void,
  ): void {
    if (!this.isOpen) return;
    const slider = container.querySelector<HTMLInputElement>(".sb-effort-slider");
    slider?.addEventListener("change", () => {
      const i = Number(slider.value);
      const next = EFFORTS[i];
      if (!next) return;
      if (onEffortChange) {
        onEffortChange(next);
        onSet(next);
        this.isOpen = false;
        rerender();
        return;
      }
      if (!sessionId) return;
      const sid = sessionId;
      void invoke<void>("set_session_effort", { sessionId: sid, effort: next })
        .then(() => { onSet(next); this.isOpen = false; rerender(); })
        .catch((err) => console.error("[statusbar] set_session_effort failed", err));
    });
    const close = (e: MouseEvent) => {
      if (!container.contains(e.target as Node)) {
        this.isOpen = false;
        rerender();
        document.removeEventListener("click", close);
      }
    };
    setTimeout(() => document.addEventListener("click", close), 0);
  }
}

// ─────────────────────────────── Model ─────────────────────────────────────

export class ModelPopover {
  isOpen = false;

  html(model: string | null): string {
    if (!this.isOpen || !model) return "";
    return `
      <div class="sb-model-popover">
        <div class="sb-model-popover-name">${escapeHtml(model)}</div>
        <div class="sb-model-popover-hint">Locked for this session. Start a new session to change.</div>
      </div>
    `;
  }

  wire(container: HTMLElement, rerender: () => void): void {
    if (!this.isOpen) return;
    const close = (e: MouseEvent) => {
      if (!container.contains(e.target as Node)) {
        this.isOpen = false;
        rerender();
        document.removeEventListener("click", close);
      }
    };
    setTimeout(() => document.addEventListener("click", close), 0);
  }
}
