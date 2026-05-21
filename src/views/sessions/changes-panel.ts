// Right-rail + overlay-sheet controller for the "all changes in this chat"
// view. Mounted via the changes-btn icon in active-session.ts. State is
// ephemeral per session: reviewed set is in-memory and lives on this
// instance only.

import type { FileEditView } from "../../shared/chat/file-edits";
import { renderStackedDiff } from "../../shared/chat/edit-window";
import { escapeHtml } from "../../shared/escape-html";

export interface DedupedRow {
  path: string;
  basename: string;
  kind: FileEditView["kind"];
  addedLines: number;
  removedLines: number;
}

export function dedupeByPath(edits: FileEditView[]): DedupedRow[] {
  const byPath = new Map<string, DedupedRow>();
  edits.forEach((e) => {
    const existing = byPath.get(e.path);
    if (existing) {
      existing.addedLines += e.addedLines;
      existing.removedLines += e.removedLines;
    } else {
      byPath.set(e.path, {
        path: e.path,
        basename: e.basename,
        kind: e.kind,
        addedLines: e.addedLines,
        removedLines: e.removedLines,
      });
    }
  });
  return Array.from(byPath.values());
}

export class ChangesPanel {
  private host: HTMLElement | null = null;
  private chatEl: HTMLElement | null = null;
  private edits: FileEditView[] = [];
  private reviewed = new Set<string>();
  private openSheetPath: string | null = null;
  private isOpen = false;

  mount(host: HTMLElement, chatEl: HTMLElement): void {
    this.host = host;
    this.chatEl = chatEl;
  }

  unmount(): void {
    this.close();
    this.host = null;
    this.chatEl = null;
    this.edits = [];
    this.reviewed.clear();
    this.openSheetPath = null;
  }

  onUpdate(edits: FileEditView[]): void {
    this.edits = edits;
    if (this.isOpen) this.renderRail();
    if (this.openSheetPath) this.renderSheet();
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  private open(): void {
    if (!this.host || !this.chatEl) return;
    this.isOpen = true;
    this.chatEl.classList.add("chat--dimmed");
    this.renderRail();
  }

  private close(): void {
    if (!this.host) return;
    this.isOpen = false;
    this.openSheetPath = null;
    this.chatEl?.classList.remove("chat--dimmed");
    this.host.querySelector(".changes-rail")?.remove();
    this.host.querySelector(".changes-sheet")?.remove();
  }

  private renderRail(): void {
    if (!this.host) return;
    const rows = dedupeByPath(this.edits);
    const reviewedCount = rows.filter((r) => this.reviewed.has(r.path)).length;
    const rowsHtml = rows.map((r) => {
      const checked = this.reviewed.has(r.path) ? " checked" : "";
      const adds = r.addedLines > 0 ? `<span class="diff-add">+${r.addedLines}</span>` : "";
      const dels = r.removedLines > 0 ? `<span class="diff-del">-${r.removedLines}</span>` : "";
      return `<div class="changes-row" data-path="${escapeHtml(r.path)}"><i class="ph ph-file"></i><span class="changes-row-name">${escapeHtml(r.basename)}</span><span class="changes-row-meta">${adds} ${dels}</span><input type="checkbox" class="changes-row-reviewed"${checked}></div>`;
    }).join("");
    const html = `<aside class="changes-rail"><header class="changes-rail-hdr"><span class="changes-rail-title">Changes</span><span class="changes-rail-chip">${reviewedCount} of ${rows.length} reviewed</span><button class="changes-rail-close" aria-label="Close"><i class="ph ph-x"></i></button></header><div class="changes-rail-list">${rowsHtml}</div></aside>`;
    const existing = this.host.querySelector(".changes-rail");
    if (existing) existing.outerHTML = html;
    else this.host.insertAdjacentHTML("beforeend", html);
    this.host.querySelector(".changes-rail-close")?.addEventListener("click", () => this.close());
    this.host.querySelectorAll<HTMLElement>(".changes-row").forEach((row) => {
      row.addEventListener("click", (e) => {
        const target = e.target as HTMLElement;
        if (target.classList.contains("changes-row-reviewed")) return;
        const path = row.dataset.path ?? null;
        if (path) {
          this.openSheetPath = path;
          this.renderSheet();
        }
      });
    });
    this.host.querySelectorAll<HTMLInputElement>(".changes-row-reviewed").forEach((cb) => {
      cb.addEventListener("change", (e) => {
        const row = (e.target as HTMLElement).closest<HTMLElement>(".changes-row");
        const path = row?.dataset.path;
        if (!path) return;
        if (cb.checked) this.reviewed.add(path);
        else this.reviewed.delete(path);
        this.renderRail();
      });
    });
  }

  private renderSheet(): void {
    if (!this.host || !this.openSheetPath) return;
    const path = this.openSheetPath;
    const matching = this.edits.filter((e) => e.path === path);
    const basename = matching[0]?.basename ?? path;
    const body = renderStackedDiff(matching);
    const html = `<section class="changes-sheet"><header class="changes-sheet-hdr"><span>${escapeHtml(basename)}</span><button class="changes-sheet-close" aria-label="Close"><i class="ph ph-x"></i></button></header><div class="changes-sheet-body">${body}</div></section>`;
    const existing = this.host.querySelector(".changes-sheet");
    if (existing) existing.outerHTML = html;
    else this.host.insertAdjacentHTML("beforeend", html);
    this.host.querySelector(".changes-sheet-close")?.addEventListener("click", () => {
      this.openSheetPath = null;
      this.host?.querySelector(".changes-sheet")?.remove();
    });
  }
}
