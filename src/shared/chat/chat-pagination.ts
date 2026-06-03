import type { ChatEvent } from "../../types/ipc.generated";
import type { RenderedMessage } from "./chat-transforms";
import { eventToRenderedMessage } from "./chat-transforms";
import { sessionEvents } from "./event-store";
import { highlightCodeBlocks } from "./code-highlighter";

export interface PaginatorCallbacks {
  getSessionId(): string | null;
  getMessages(): RenderedMessage[];
  getMessageEls(): HTMLElement[];
  setMessages(m: RenderedMessage[]): void;
  setMessageEls(els: HTMLElement[]): void;
  buildMessageEl(m: RenderedMessage): HTMLElement;
  clampUserMessages(): void;
  /** Called after a prepend with the number of rows inserted at the front. */
  onShift(n: number): void;
}

/** Walk up to the direct child of container. Used to find insertion point for prepend. */
export function rootChildOf(container: HTMLElement, el: HTMLElement): HTMLElement {
  let n = el;
  while (n.parentElement && n.parentElement !== container) {
    n = n.parentElement as HTMLElement;
  }
  return n;
}

export class ChatPaginator {
  cwdHint: string | undefined;
  private topSentinel: HTMLElement | null = null;
  private topObserver: IntersectionObserver | null = null;

  constructor(private container: HTMLElement, private cb: PaginatorCallbacks) {}

  install(): void {
    this.remove();
    const sid = this.cb.getSessionId();
    if (!sid || !sessionEvents.hasMore(sid)) return;
    const sentinel = document.createElement("div");
    sentinel.className = "chat-top-sentinel";
    sentinel.innerHTML = '<div class="chat-top-spinner" hidden></div>';
    this.container.prepend(sentinel);
    this.topSentinel = sentinel;
    this.topObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) void this.fetchOlder();
      }
    });
    this.topObserver.observe(sentinel);
  }

  remove(): void {
    if (this.topObserver) {
      try { this.topObserver.disconnect(); } catch { /* ignore */ }
      this.topObserver = null;
    }
    if (this.topSentinel && this.topSentinel.parentNode) {
      this.topSentinel.parentNode.removeChild(this.topSentinel);
    }
    this.topSentinel = null;
  }

  async fetchOlder(): Promise<void> {
    const sid = this.cb.getSessionId();
    if (!sid) return;
    if (!sessionEvents.hasMore(sid)) {
      this.remove();
      return;
    }
    const spinner = this.topSentinel?.querySelector(".chat-top-spinner") as HTMLElement | null;
    if (spinner) spinner.hidden = false;
    const scroller = this.findScroller();
    const oldScrollTop = scroller ? scroller.scrollTop : 0;
    const oldScrollHeight = scroller ? scroller.scrollHeight : 0;

    const older = await sessionEvents.loadOlder(sid, this.cwdHint);
    if (this.cb.getSessionId() !== sid) return;

    if (!older || older.length === 0) {
      if (spinner) spinner.hidden = true;
      if (!sessionEvents.hasMore(sid)) this.remove();
      return;
    }

    this.prependEvents(older);
    if (this.cb.getSessionId() !== sid) return;

    if (scroller) {
      const newScrollHeight = scroller.scrollHeight;
      scroller.scrollTop = oldScrollTop + (newScrollHeight - oldScrollHeight);
    }

    if (sessionEvents.hasMore(sid)) {
      this.install();
    } else {
      this.remove();
    }
  }

  prependEvents(events: ChatEvent[]): void {
    if (events.length === 0) return;

    const messages = this.cb.getMessages();
    const messageEls = this.cb.getMessageEls();
    const newMessages: RenderedMessage[] = [];
    const newEls: HTMLElement[] = [];
    const frag = document.createDocumentFragment();

    for (const ev of events) {
      const msg = eventToRenderedMessage(ev);
      if (!msg) continue;
      newMessages.push(msg);
      const el = this.cb.buildMessageEl(msg);
      newEls.push(el);
      frag.appendChild(el);
    }

    if (newMessages.length === 0) return;

    const firstExisting = messageEls[0] ?? null;
    if (firstExisting) {
      this.container.insertBefore(frag, rootChildOf(this.container, firstExisting));
    } else if (this.topSentinel && this.topSentinel.parentNode === this.container) {
      this.container.appendChild(frag);
    } else {
      this.container.prepend(frag);
    }

    const shift = newMessages.length;
    this.cb.setMessages([...newMessages, ...messages]);
    this.cb.setMessageEls([...newEls, ...messageEls]);
    this.cb.onShift(shift);

    void highlightCodeBlocks(this.container);
    this.cb.clampUserMessages();
  }

  findScroller(): HTMLElement | null {
    let n: HTMLElement | null = this.container;
    while (n) {
      const overflowY = getComputedStyle(n).overflowY;
      if ((overflowY === "auto" || overflowY === "scroll") && n.scrollHeight > n.clientHeight) {
        return n;
      }
      n = n.parentElement;
    }
    return null;
  }
}
