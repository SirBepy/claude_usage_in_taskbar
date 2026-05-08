// Per-session event store. Caches ChatEvents per session_id and maintains a
// single Tauri `chat:<id>` listener for any session that has been touched, so:
//
// - reopening a session is instant (cache hit, no load_history IPC, no JSONL
//   re-parse)
// - detached/unselected sessions keep accumulating events in the background
//   so the user does not miss messages when they come back
// - multiple consumers (sidebar pane + detached window) share one upstream
//   listener instead of each opening their own
//
// Cache invalidation: entries live until app restart. session_ended is just
// another event in the cache; the renderer surfaces it as a system message.

import type { ChatEvent } from "../../types/ipc.generated";
import { invoke } from "../ipc";

type Unlisten = () => void;
type EventListener = (ev: ChatEvent) => void;

interface CacheEntry {
  events: ChatEvent[];
  unlisten: Unlisten | null;
  subscribers: Set<EventListener>;
  /** True once load_history has resolved (or determined empty). */
  loaded: boolean;
}

class SessionEventStore {
  private cache = new Map<string, CacheEntry>();

  /** Snapshot of currently cached events. */
  events(sessionId: string): ChatEvent[] {
    return this.cache.get(sessionId)?.events.slice() ?? [];
  }

  isLoaded(sessionId: string): boolean {
    return !!this.cache.get(sessionId)?.loaded;
  }

  /**
   * Ensure the cache contains the JSONL history for `sessionId` and is
   * subscribed to live events. Returns the live (mutable internal) event
   * array; do not mutate. Subscribe via `subscribe` for live updates. If
   * already loaded, returns immediately without IPC.
   */
  async ensureLoaded(sessionId: string, cwd?: string): Promise<ChatEvent[]> {
    let entry = this.cache.get(sessionId);
    if (entry?.loaded) {
      await this.ensureListener(sessionId);
      return entry.events;
    }
    if (!entry) {
      entry = this.makeEntry();
      this.cache.set(sessionId, entry);
    }
    // Attach listener BEFORE load_history so live events emitted during the
    // IPC call land in the cache (claude could finish a turn mid-fetch).
    await this.ensureListener(sessionId);
    const liveDuringFetch = entry.events.length;
    try {
      const args: { sessionId: string; cwd?: string } = { sessionId };
      if (cwd) args.cwd = cwd;
      const history = (await invoke<ChatEvent[]>("load_history", args)) || [];
      // Merge: history is the disk prefix; anything captured by the listener
      // since we attached is the live tail. Preserve the tail by slicing
      // entries[liveDuringFetch..] (everything appended via the listener) and
      // appending it after the full history snapshot.
      const liveTail = entry.events.slice(liveDuringFetch);
      entry.events = history.concat(liveTail);
    } catch {
      /* tolerate absence (no JSONL yet for brand-new sessions) */
    }
    entry.loaded = true;
    return entry.events;
  }

  /**
   * Subscribe to live events for `sessionId`. Returns an unsubscribe closure.
   * The store keeps the upstream Tauri listener alive even after the last
   * subscriber leaves (cache stays warm).
   */
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

  /**
   * Migrate cache + listener from `fromId` to `toId`. Used when a pending
   * placeholder session id resolves to the real id captured from
   * SessionStarted. Subscribers are preserved across the swap; the
   * `chat:<fromId>` listener is torn down and `chat:<toId>` attached.
   */
  async swap(fromId: string, toId: string): Promise<void> {
    if (fromId === toId) return;
    const fromEntry = this.cache.get(fromId);
    if (!fromEntry) return;
    if (fromEntry.unlisten) {
      try { fromEntry.unlisten(); } catch { /* ignore */ }
      fromEntry.unlisten = null;
    }
    this.cache.delete(fromId);
    // If toId already has a (probably empty) entry from an early subscribe,
    // merge subscribers into it. Otherwise reuse fromEntry under toId.
    const existing = this.cache.get(toId);
    if (existing) {
      for (const ev of fromEntry.events) existing.events.push(ev);
      for (const sub of fromEntry.subscribers) existing.subscribers.add(sub);
      existing.loaded = existing.loaded || fromEntry.loaded;
    } else {
      this.cache.set(toId, fromEntry);
    }
    await this.ensureListener(toId);
  }

  /**
   * Push a synthetic event into the cache (e.g. optimistic user_message that
   * the runner does not echo back via stream-json). Subscribers see it via
   * the same callback path as live events.
   */
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
    return { events: [], unlisten: null, subscribers: new Set(), loaded: false };
  }

  private async ensureListener(sessionId: string): Promise<void> {
    const entry = this.cache.get(sessionId);
    if (!entry || entry.unlisten) return;
    const ev = window.__TAURI__?.event;
    if (!ev?.listen) return;
    entry.unlisten = await ev.listen<ChatEvent>(`chat:${sessionId}`, (e) => {
      const cur = this.cache.get(sessionId);
      if (!cur) return;
      cur.events.push(e.payload);
      cur.subscribers.forEach((fn) => {
        try { fn(e.payload); } catch { /* ignore */ }
      });
    });
  }
}

export const sessionEvents = new SessionEventStore();
