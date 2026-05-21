// Per-session event store. Caches paginated ChatEvents per session_id and
// maintains a single Tauri `chat:<id>` listener for any session that has been
// touched, so:
//
// - reopening a session is instant (cache hit, no IPC, no JSONL re-parse)
// - detached/unselected sessions keep accumulating live events in the
//   background so the user does not miss messages when they come back
// - multiple consumers (sidebar pane + detached window) share one upstream
//   listener instead of each opening their own
//
// Pagination: chat-open path uses `loadInitial` (last 20 messages) and
// `loadOlder` (next 20 older), backed by the `load_history_page` IPC. The
// History view (read-only browse) still uses `load_history` directly.

import type { ChatEvent, HistoryPage } from "../../types/ipc.generated";
import { invoke } from "../ipc";

type Unlisten = () => void;
type EventListener = (ev: ChatEvent) => void;

// Page size counts AssistantMessage events only — see read_page in
// src-tauri/src/chat/history.rs. 10 AI replies plus all surrounding
// user/tool/turn events typically renders well under 100 ms.
const INITIAL_PAGE_SIZE = 10;
const OLDER_PAGE_SIZE = 10;

interface CacheEntry {
  events: ChatEvent[];
  oldestSeq: number | null;
  hasMore: boolean;
  loadingOlder: boolean;
  initialLoaded: boolean;
  unlisten: Unlisten | null;
  unlistenWatch: Unlisten | null;
  subscribers: Set<EventListener>;
}

class SessionEventStore {
  private cache = new Map<string, CacheEntry>();

  events(sessionId: string): ChatEvent[] {
    return this.cache.get(sessionId)?.events.slice() ?? [];
  }

  isLoaded(sessionId: string): boolean {
    return !!this.cache.get(sessionId)?.initialLoaded;
  }

  hasMore(sessionId: string): boolean {
    return !!this.cache.get(sessionId)?.hasMore;
  }

  /**
   * Fetch the last `INITIAL_PAGE_SIZE` messages for `sessionId` and attach
   * the live listener. Idempotent: subsequent calls return the cached array
   * without re-fetching. Returns the live (mutable internal) event array.
   */
  async loadInitial(sessionId: string, cwd?: string): Promise<ChatEvent[]> {
    let entry = this.cache.get(sessionId);
    if (entry?.initialLoaded) {
      await this.ensureListener(sessionId);
      return entry.events;
    }
    if (!entry) {
      entry = this.makeEntry();
      this.cache.set(sessionId, entry);
    }
    await this.ensureListener(sessionId);
    try {
      const args: { sessionId: string; cwd?: string; messageLimit: number } = {
        sessionId,
        messageLimit: INITIAL_PAGE_SIZE,
      };
      if (cwd) args.cwd = cwd;
      // Snapshot the live events that exist BEFORE fetching the authoritative
      // JSONL page. Everything already buffered is either covered by the page
      // (claude has written it to the transcript) or a synthetic echo we added
      // optimistically (pushSynthetic) - the page is the source of truth for
      // all of it. Keep only events that streamed in DURING/AFTER the fetch,
      // identified by object identity rather than timestamp.
      //
      // Why not timestamp: the live `-p` stream carries no timestamp and JSONL
      // timestamps are ISO strings the parser leaves as 0, so the old
      // timestamp filter compared garbage - the synthetic user message (real
      // Date.now() ms) always passed and got re-appended on top of its JSONL
      // copy, duplicating + reordering messages on chat reload (ai_todo 65).
      const liveBefore = new Set(entry.events);
      const page = await invoke<HistoryPage>("load_history_page", args);
      const liveAfterPage = entry.events.filter((ev) => !liveBefore.has(ev));
      entry.events = [...page.events, ...liveAfterPage];
      entry.oldestSeq = Number(page.oldest_seq);
      entry.hasMore = page.has_more;
    } catch {
      /* tolerate absence (no JSONL yet for brand-new sessions) */
    }
    entry.initialLoaded = true;
    return entry.events;
  }

  /**
   * Fetch the previous page of older messages and prepend them to the cache.
   * Returns the prepended slice, or null if there is nothing more to load
   * or a load is already in flight.
   */
  async loadOlder(sessionId: string, cwd?: string): Promise<ChatEvent[] | null> {
    const entry = this.cache.get(sessionId);
    if (!entry || !entry.initialLoaded) return null;
    if (!entry.hasMore || entry.loadingOlder) return null;
    if (entry.oldestSeq == null) return null;
    entry.loadingOlder = true;
    try {
      const args: { sessionId: string; cwd?: string; beforeSeq: number; messageLimit: number } = {
        sessionId,
        beforeSeq: entry.oldestSeq,
        messageLimit: OLDER_PAGE_SIZE,
      };
      if (cwd) args.cwd = cwd;
      const page = await invoke<HistoryPage>("load_history_page", args);
      if (!page.events.length) {
        entry.hasMore = false;
        return null;
      }
      entry.events = [...page.events, ...entry.events];
      entry.oldestSeq = Number(page.oldest_seq);
      entry.hasMore = page.has_more;
      return page.events;
    } catch {
      return null;
    } finally {
      entry.loadingOlder = false;
    }
  }

  subscribe(sessionId: string, fn: EventListener): () => void {
    let entry = this.cache.get(sessionId);
    if (!entry) {
      entry = this.makeEntry();
      this.cache.set(sessionId, entry);
    }
    entry.subscribers.add(fn);
    void this.ensureListener(sessionId);
    return () => {
      const e = this.cache.get(sessionId);
      e?.subscribers.delete(fn);
    };
  }

  async swap(fromId: string, toId: string): Promise<void> {
    if (fromId === toId) return;
    const fromEntry = this.cache.get(fromId);
    if (!fromEntry) return;
    if (fromEntry.unlisten) {
      try { fromEntry.unlisten(); } catch { /* ignore */ }
      fromEntry.unlisten = null;
    }
    this.cache.delete(fromId);
    const existing = this.cache.get(toId);
    if (existing) {
      for (const ev of fromEntry.events) existing.events.push(ev);
      for (const sub of fromEntry.subscribers) existing.subscribers.add(sub);
      existing.initialLoaded = existing.initialLoaded || fromEntry.initialLoaded;
      existing.oldestSeq = existing.oldestSeq ?? fromEntry.oldestSeq;
      existing.hasMore = existing.hasMore && fromEntry.hasMore;
    } else {
      this.cache.set(toId, fromEntry);
    }
    await this.ensureListener(toId);
  }

  bust(sessionId: string): void {
    const entry = this.cache.get(sessionId);
    if (!entry) return;
    entry.events = [];
    entry.oldestSeq = null;
    entry.hasMore = false;
    entry.initialLoaded = false;
  }

  pushSynthetic(sessionId: string, ev: ChatEvent): void {
    let entry = this.cache.get(sessionId);
    if (!entry) {
      entry = this.makeEntry();
      this.cache.set(sessionId, entry);
    }
    entry.events.push(ev);
    entry.subscribers.forEach((fn) => {
      try { fn(ev); } catch { /* ignore */ }
    });
  }

  private makeEntry(): CacheEntry {
    return {
      events: [],
      oldestSeq: null,
      hasMore: false,
      loadingOlder: false,
      initialLoaded: false,
      unlisten: null,
      unlistenWatch: null,
      subscribers: new Set(),
    };
  }

  private async ensureListener(sessionId: string): Promise<void> {
    const entry = this.cache.get(sessionId);
    if (!entry || entry.unlisten) return;
    const ev = window.__TAURI__?.event;
    if (!ev?.listen) return;
    entry.unlisten = await ev.listen<ChatEvent>(`chat:${sessionId}`, (e) => {
      const cur = this.cache.get(sessionId);
      if (!cur) return;
      // claude -p --resume replays the full conversation history including past
      // user messages. Those arrive here as live events and would duplicate what
      // pushSynthetic already added (current turn) or loadInitial loads from
      // JSONL (history). Drop all user_message events from the live stream.
      if (e.payload.type === "user_message") return;
      cur.events.push(e.payload);
      cur.subscribers.forEach((fn) => {
        try { fn(e.payload); } catch { /* ignore */ }
      });
    });
  }

  // Subscribes to chat-watch:<id> events emitted by the JSONL file watcher.
  // Unlike the runner channel, user_messages are allowed through (they come
  // from terminal input, not from claude -p re-emission). Events are
  // deduplicated against the existing cache by timestamp+type to prevent
  // doubling events the runner already pushed for app-driven turns.
  async ensureWatchListener(sessionId: string): Promise<void> {
    let entry = this.cache.get(sessionId);
    if (!entry) {
      entry = this.makeEntry();
      this.cache.set(sessionId, entry);
    }
    if (entry.unlistenWatch) return;
    const ev = window.__TAURI__?.event;
    if (!ev?.listen) return;
    entry.unlistenWatch = await ev.listen<ChatEvent>(`chat-watch:${sessionId}`, (e) => {
      const cur = this.cache.get(sessionId);
      if (!cur) return;
      const payload = e.payload;
      const ts = (payload as { timestamp?: bigint }).timestamp;
      if (ts !== undefined) {
        const already = cur.events.some(
          (ex) => (ex as { timestamp?: bigint }).timestamp === ts && ex.type === payload.type
        );
        if (already) return;
      }
      cur.events.push(payload);
      cur.subscribers.forEach((fn) => {
        try { fn(payload); } catch { /* ignore */ }
      });
    });
  }

  stopWatchListener(sessionId: string): void {
    const entry = this.cache.get(sessionId);
    if (!entry?.unlistenWatch) return;
    try { entry.unlistenWatch(); } catch { /* ignore */ }
    entry.unlistenWatch = null;
  }
}

export const sessionEvents = new SessionEventStore();
