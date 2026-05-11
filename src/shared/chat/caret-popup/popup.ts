import type { PopupOptions, SuggestProvider } from "./types";

export class CaretSuggestPopup {
  private opts: PopupOptions;
  private el: HTMLDivElement;
  private items: unknown[] = [];
  private selectedIdx = 0;
  private tokenRange: [number, number] = [0, 0];
  private active: SuggestProvider<unknown> | null = null;
  private open = false;
  private onDocMouseDown: (e: MouseEvent) => void;

  constructor(opts: PopupOptions) {
    this.opts = opts;
    this.el = document.createElement("div");
    this.el.className = "caret-popup";
    this.el.hidden = true;
    opts.anchor.appendChild(this.el);

    this.onDocMouseDown = (e) => {
      if (!this.open) return;
      const t = e.target as Node;
      if (!this.el.contains(t) && t !== opts.textarea) {
        this.close();
      }
    };
    document.addEventListener("mousedown", this.onDocMouseDown);
  }

  isOpen(): boolean {
    return this.open;
  }

  handleInput(): void {
    const ta = this.opts.textarea;
    const caret = ta.selectionStart ?? ta.value.length;
    const before = ta.value.slice(0, caret);

    let chosen: SuggestProvider<unknown> | null = null;
    for (const p of this.opts.providers) {
      if (p.shouldTrigger({ textBefore: before, caretPos: caret })) {
        chosen = p;
        break;
      }
    }
    if (!chosen) {
      this.close();
      return;
    }
    const m = before.match(/(^|\s)([/@][^\s]*)$/);
    const token = m?.[2];
    if (!token) {
      this.close();
      return;
    }
    const start = caret - token.length;
    this.tokenRange = [start, caret];

    const results = chosen.query(token);
    if (!results.length) {
      this.close();
      return;
    }
    this.items = results;
    this.active = chosen;
    this.selectedIdx = 0;
    this.open = true;
    this.render();
  }

  handleKey(e: KeyboardEvent): boolean {
    if (!this.open) return false;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        this.selectedIdx = (this.selectedIdx + 1) % this.items.length;
        this.render();
        return true;
      case "ArrowUp":
        e.preventDefault();
        this.selectedIdx = (this.selectedIdx - 1 + this.items.length) % this.items.length;
        this.render();
        return true;
      case "Enter":
      case "Tab": {
        e.preventDefault();
        const item = this.items[this.selectedIdx];
        if (item !== undefined) this.pick(item);
        return true;
      }
      case "Escape":
        e.preventDefault();
        this.close();
        return true;
    }
    return false;
  }

  destroy(): void {
    document.removeEventListener("mousedown", this.onDocMouseDown);
    this.el.remove();
  }

  private pick(item: unknown): void {
    this.active?.onPick(item, this.opts.textarea, this.tokenRange);
    this.close();
  }

  private close(): void {
    this.open = false;
    this.active = null;
    this.el.hidden = true;
    this.el.replaceChildren();
  }

  private render(): void {
    if (!this.active) return;
    const active = this.active;
    this.el.hidden = false;
    const rows = this.items.map((it, i) => {
      const row = active.renderRow(it, i === this.selectedIdx);
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.pick(it);
      });
      return row;
    });
    this.el.replaceChildren(...rows);
    rows[this.selectedIdx]?.scrollIntoView?.({ block: "nearest" });
  }
}
