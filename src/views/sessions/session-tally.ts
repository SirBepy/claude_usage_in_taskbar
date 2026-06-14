import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import { openLightbox } from "../../shared/chat/lightbox";
import { toolSummary, toolLabel, type ToolTally } from "../../shared/chat/tool-meta";
import { CUSTOM_VIEW_TOOLS } from "../../shared/chat/tool-views";
import "./session-tally.css";

// Cumulative tool tally row: one chip per tool type, each its OWN drill-down
// popover listing that tool's distinct targets (files open in the editor,
// images open a lightbox, Grep/Bash targets are plain text). The row is
// always-on when tools have run, not a configurable statusline field.
//
// Owns the chip-row HTML build, the body-appended drill-down popover, its
// open/close/toggle, per-item rendering, outside-click cleanup and the
// downward/upward positioning. SessionStatusbar holds the toolTally +
// tallyHiddenTools STATE and delegates the row build + chip click wiring here.
export class ToolTallyRow {
  private container: HTMLElement;
  private toolTally: ToolTally = { byType: [] };
  private tallyPopoverEl: HTMLElement | null = null;
  private tallyPopoverCleanup: (() => void) | null = null;
  // Which tool's popover is open (null = none); kept so updateToolTally can
  // rebuild it in place as more calls of that type stream in.
  private tallyOpenTool: string | null = null;
  // Provider for the shared custom views (Read/File Changes/Skills/Questions),
  // backed by the chat renderer's messages. When set, custom-tool popovers reuse
  // the exact same markup as the in-chat chip panels instead of the generic
  // target list. Null until the renderer is wired (e.g. pending-pane previews).
  private getCustomView: ((tool: string) => string | null) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  /** Wire the shared custom-view provider (the chat renderer's message-derived
   *  HTML). Safe to call after construction; refreshes an open popover. */
  setCustomViewProvider(fn: (tool: string) => string | null): void {
    this.getCustomView = fn;
    if (this.tallyOpenTool) this.openToolPopover(this.tallyOpenTool);
  }

  /** Build ONE tool chip's HTML (count + drill-down affordance) for a given
   *  tool, or "" when hideZero is on and the count is 0 / the tool never ran.
   *  `count` is passed by the caller (SessionStatusbar owns the tally state);
   *  this controller only owns the popover. Used by the rows renderer, which
   *  places each tool as an individual chip. */
  renderChipFor(tool: string, count: number, hideZero: boolean): string {
    if (count === 0 && hideZero) return "";
    const { icon } = toolSummary(tool, {});
    const label = toolLabel(tool);
    return `<span class="sb-tally-chip sb-chip" role="button" tabindex="0" data-tool="${escapeHtml(tool)}" title="${escapeHtml(label)} targets"><i class="ph ${icon}"></i>${escapeHtml(label)} x${count}</span>`;
  }

  // Wire the freshly-rendered chips' click handlers. Call after the container's
  // innerHTML is set on every render.
  wireChips(): void {
    this.container.querySelectorAll<HTMLElement>(".sb-tally-chip").forEach((chip) => {
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        const tool = chip.dataset.tool;
        if (tool) this.toggleToolPopover(tool);
      });
    });
  }

  // Sync the tally state + keep an open popover in sync after a re-render: the
  // chips were rebuilt, so reattach the open popover to the new anchor (or close
  // it if its tool vanished).
  update(tally: ToolTally): void {
    this.toolTally = tally;
    const openTool = this.tallyPopoverEl !== null ? this.tallyOpenTool : null;
    if (openTool && tally.byType.some((b) => b.tool === openTool)) {
      this.openToolPopover(openTool);
    } else {
      this.closeTallyPopover();
    }
  }

  destroy(): void {
    this.closeTallyPopover();
  }

  private toggleToolPopover(tool: string): void {
    if (this.tallyPopoverEl && this.tallyOpenTool === tool) this.closeTallyPopover();
    else this.openToolPopover(tool);
  }

  private closeTallyPopover(): void {
    this.tallyPopoverCleanup?.();
    this.tallyPopoverCleanup = null;
    this.tallyPopoverEl?.remove();
    this.tallyPopoverEl = null;
    this.tallyOpenTool = null;
  }

  // Per-tool drill-down popover, anchored to that tool's chip. Mirrors
  // openMoreMenu in active-session.ts: a body-appended fixed element positioned
  // off the anchor, dismissed on outside click, cleaned up on close/destroy.
  // Rebuilt in place (same tool) as more calls of that type stream in.
  private openToolPopover(tool: string): void {
    const anchor = [...this.container.querySelectorAll<HTMLElement>(".sb-tally-chip")]
      .find((c) => c.dataset.tool === tool);
    if (!anchor) return;
    this.tallyPopoverCleanup?.();
    this.tallyPopoverCleanup = null;
    this.tallyPopoverEl?.remove();
    this.tallyOpenTool = tool;

    const pop = document.createElement("div");
    pop.className = "sb-tally-popover";
    pop.innerHTML = `<div class="sb-tally-list">${this.renderToolItems(tool)}</div>`;
    document.body.appendChild(pop);
    this.tallyPopoverEl = pop;

    const rect = anchor.getBoundingClientRect();
    // Clamp horizontally so the fixed-width dropdown never spills off either
    // edge: left-align to the chip, but pull back when it would overflow the
    // right side, and never go past an 8px left margin.
    const maxLeft = window.innerWidth - pop.offsetWidth - 8;
    pop.style.left = `${Math.max(8, Math.min(rect.left, maxLeft))}px`;
    // Open downward off the chip; only flip above when there isn't room below
    // (and there's more room above) so it never clips off-screen.
    const below = window.innerHeight - rect.bottom;
    if (below >= pop.offsetHeight + 8 || below >= rect.top) {
      pop.style.top = `${rect.bottom + 4}px`;
    } else {
      pop.style.bottom = `${window.innerHeight - rect.top + 4}px`;
    }

    pop.querySelectorAll<HTMLElement>(".sb-tally-file").forEach((row) => {
      row.addEventListener("click", () => {
        const path = row.dataset.path;
        if (path) void invoke<void>("open_in_editor", { path }).catch((err) => console.error("[statusbar] open_in_editor failed", err));
      });
    });

    // Shared custom-view file rows (Read / File Changes) open in the editor too.
    pop.querySelectorAll<HTMLElement>(".tool-file-row[data-path]").forEach((row) => {
      row.addEventListener("click", () => {
        const path = row.dataset.path;
        if (path) void invoke<void>("open_in_editor", { path }).catch((err) => console.error("[statusbar] open_in_editor failed", err));
      });
    });

    pop.querySelectorAll<HTMLElement>(".sb-tally-media").forEach((row) => {
      const path = row.dataset.path;
      const filename = row.dataset.filename ?? "";
      const imgEl = row.querySelector<HTMLImageElement>("img");
      if (path && imgEl) {
        void invoke<{ mime: string; base64: string }>("read_image_file", { path })
          .then((res) => { imgEl.src = `data:${res.mime};base64,${res.base64}`; })
          .catch(() => { row.classList.add("sb-tally-media-error"); });
      }
      row.addEventListener("click", () => {
        if (!path) return;
        void invoke<{ mime: string; base64: string }>("read_image_file", { path })
          .then((res) => openLightbox({ type: "image", mime: res.mime, base64: res.base64, filename }))
          .catch((err) => console.error("[statusbar] read_image_file failed", err));
      });
    });

    const onOutside = (e: MouseEvent) => {
      if (!pop.contains(e.target as Node) && !anchor.contains(e.target as Node)) {
        this.closeTallyPopover();
      }
    };
    setTimeout(() => document.addEventListener("click", onOutside), 0);
    this.tallyPopoverCleanup = () => document.removeEventListener("click", onOutside);
  }

  private renderToolItems(tool: string): string {
    // Custom-view tools (Read / File Changes / Skills / Questions) reuse the
    // shared in-chat markup, built from the renderer's messages.
    if (CUSTOM_VIEW_TOOLS.has(tool) && this.getCustomView) {
      const html = this.getCustomView(tool);
      if (html) return html;
      return `<div class="sb-tally-empty">No targets</div>`;
    }
    const entry = this.toolTally.byType.find((b) => b.tool === tool);
    const items = entry?.items ?? [];
    if (items.length === 0) return `<div class="sb-tally-empty">No targets</div>`;
    return items.map((it) => {
      const count = it.count > 1 ? ` <span class="sb-tally-count">x${it.count}</span>` : "";
      if (it.kind === "image" && it.path) {
        const pathEsc = escapeHtml(it.path);
        const nameEsc = escapeHtml(it.filename ?? it.label);
        return `<div class="sb-tally-media" role="button" title="${pathEsc}" data-path="${pathEsc}" data-filename="${nameEsc}"><span class="sb-tally-thumb"><img alt="${nameEsc}"><i class="ph ph-image sb-tally-thumb-ph"></i></span><span class="sb-tally-name">${nameEsc}</span>${count}</div>`;
      }
      if (it.kind === "file" && it.path) {
        const pathEsc = escapeHtml(it.path);
        return `<div class="sb-tally-file" role="button" title="${pathEsc}" data-path="${pathEsc}"><i class="ph ph-file"></i><span class="sb-tally-name">${escapeHtml(it.label)}</span><span class="sb-tally-path">${pathEsc}</span>${count}</div>`;
      }
      const labelEsc = escapeHtml(it.label);
      return `<div class="sb-tally-text" title="${labelEsc}"><i class="ph ${toolSummary(tool, {}).icon}"></i><span class="sb-tally-name">${labelEsc}</span>${count}</div>`;
    }).join("");
  }
}
