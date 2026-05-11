import type { PopupOptions } from "./types";

export class CaretSuggestPopup<T> {
  private opts: PopupOptions<T>;
  private el: HTMLDivElement;
  private items: T[] = [];
  private selectedIdx = 0;
  private tokenRange: [number, number] = [0, 0];
  private open = false;
  private onDocMouseDown: (e: MouseEvent) => void;

  constructor(opts: PopupOptions<T>) {
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

    if (!this.opts.provider.shouldTrigger({ textBefore: before, caretPos: caret })) {
      this.close();
      return;
    }
    const m = before.match(/(^|\n)([/@][^\s]*)$/);
    if (!m) {
      this.close();
      return;
    }
    const token = m[2];
    const start = caret - token.length;
    this.tokenRange = [start, caret];

    const results = this.opts.provider.query(token);
    if (!results.length) {
      this.close();
      return;
    }
    this.items = results;
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
      case "Tab":
        e.preventDefault();
        this.pick(this.items[this.selectedIdx]);
        return true;
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

  private pick(item: T): void {
    this.opts.provider.onPick(item, this.opts.textarea, this.tokenRange);
    this.close();
  }

  private close(): void {
    this.open = false;
    this.el.hidden = true;
    this.el.replaceChildren();
  }

  private render(): void {
    this.el.hidden = false;
    this.el.replaceChildren(
      ...this.items.map((it, i) => {
        const row = this.opts.provider.renderRow(it, i === this.selectedIdx);
        row.addEventListener("mousedown", (e) => {
          e.preventDefault();
          this.pick(it);
        });
        return row;
      }),
    );
  }
}
