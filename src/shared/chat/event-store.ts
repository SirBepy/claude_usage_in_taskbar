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
import { getTransport } from "../transport";
import { normalizeUserMessageText } from "./chat-transforms";

type Unlisten = () => void;
type EventListener = (ev: ChatEvent) => void;

// Page size counts AssistantMessage events only — see read_page in
// src-tauri/src/chat/history.rs. 10 AI replies plus all surrounding
// user/tool/turn events typically renders well under 100 ms.
const INITIAL_PAGE_SIZE = 10;
const OLDER_PAGE_SIZE = 10;

// Window within which two live deliveries of the same logical event are
// treated as duplicates. The runner stream (`chat:<id>`) and the file watcher
// (`chat-watch:<id>`) both surface the same app-driven turn, and live `-p`
// events all carry timestamp=0, so we dedup by content within a short window
// rather than by (timestamp,type). Distinct turns that happen to share text
// are minutes apart and fall outside the window. See ai_todo 77.
const DEDUP_WINDOW_MS = 10_000;

// Attachment tokens (<file:path> / <file:path::name>) the composer appends as
// their own text blocks. Stripped from the dedup signature only — see the
// user_message case in sigOf for why.
const FILE_TOKEN_SIG_RE = /<file:[^>]*>/g;

interface RecentSig {
  /** Dedup key: type + content/id. */
  sig: string;
  /** Concatenated text for finalized assistant messages; used to suppress a
   * runner streaming partial whose text is a prefix of a watcher-delivered
   * final (and vice versa). Null for non-assistant events. */
  text: string | null;
  /** True when this was a finalized (non-streaming) assistant message. */
  assistantFinal: boolean;
  ts: number;
}

interface CacheEntry {
  events: ChatEvent[];
  oldestSeq: number | null;
  hasMore: boolean;
  loadingOlder: boolean;
  initialLoaded: boolean;
  unlisten: Unlisten | null;
  unlistenWatch: Unlisten | null;
  subscribers: Set<EventListener>;
  /** Recently-delivered live event signatures, for cross-source dedup. */
  recent: RecentSig[];
}

class SessionEventStore {
  private cache = new Map<string, CacheEntry>();
  /** Routes rate-limit rejections to the global banner instead of the transcript. */
  private rateLimitHandler: ((sessionId: string, body: string) => void) | null = null;

  /** Register the global rate-limit-rejection sink (the banner controller). */
  setRateLimitHandler(fn: (sessionId: string, body: string) => void): void {
    this.rateLimitHandler = fn;
  }

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
   * Re-read the authoritative JSONL transcript tail and recover any committed
   * message the live channel never delivered. The daemon->app notifier is lossy
   * (drops frames under backpressure - see project_daemon_notifier_broadcast_lossy),
   * so a turn that completed while this session was backgrounded can be absent
   * from the cache even though the sidebar marked it "done" (that status rides a
   * separate, more reliable channel). loadInitial is deliberately idempotent and
   * will NOT refetch once cached, so without this a reopened session shows the
   * stale cache until a manual refresh. This always hits the page and self-heals.
   *
   * Recovered events are appended in transcript order and pushed through the
   * normal subscriber path so an open renderer paints them. Double-render-safe:
   * only events whose content signature is absent from the cache are recovered.
   * A finalized assistant whose text matches a cached streaming partial counts
   * as already present (the partial covers its finalized form). No-op until
   * initialLoaded - there is nothing to reconcile against before the first load.
   */
  async reconcileLatest(sessionId: string, cwd?: string): Promise<void> {
    const entry = this.cache.get(sessionId);
    if (!entry || !entry.initialLoaded) return;
    let page: HistoryPage;
    try {
      const args: { sessionId: string; cwd?: string; messageLimit: number } = {
        sessionId,
        messageLimit: INITIAL_PAGE_SIZE,
      };
      if (cwd) args.cwd = cwd;
      page = await invoke<HistoryPage>("load_history_page", args);
    } catch {
      return; // no transcript yet / read error - nothing to reconcile against
    }
    const have = new Set<string>();
    for (const ev of entry.events) {
      const s = this.sigOf(ev);
      if (s !== null) {
        have.add(s);
      } else if (ev.type === "assistant_message") {
        // Streaming partial: its accumulated text covers the finalized form, so
        // a matching page final isn't a fresh drop. The last partial carries the
        // full text, which equals the final's sig.
        const t = this.contentText(ev);
        if (t !== null) have.add(`a:${t}`);
      }
    }
    const missing = page.events.filter((ev) => {
      const s = this.sigOf(ev);
      return s !== null && !have.has(s);
    });
    if (missing.length === 0) return;
    for (const ev of missing) {
      entry.events.push(ev);
      this.recordSig(entry, ev);
      entry.subscribers.forEach((fn) => {
        try { fn(ev); } catch { /* ignore */ }
      });
    }
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
      for (const r of fromEntry.recent) existing.recent.push(r);
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
    entry.recent = [];
  }

  pushSynthetic(sessionId: string, ev: ChatEvent): void {
    let entry = this.cache.get(sessionId);
    if (!entry) {
      entry = this.makeEntry();
      this.cache.set(sessionId, entry);
    }
    this.deliver(sessionId, ev);
  }

  /**
   * Common delivery gate for all LIVE event sources (runner stream, file
   * watcher, synthetic echoes). Drops cross-source duplicates of the same
   * logical event, then pushes to the cache and notifies subscribers.
   *
   * Does NOT cover `loadInitial` / `loadOlder`: those install authoritative
   * JSONL pages directly and reconcile against live events by object identity.
   */
  private deliver(sessionId: string, ev: ChatEvent): void {
    // Rate-limit rejections drive the global banner, not a transcript row.
    // Route them out before the entry/dedup path so they surface for ANY
    // session the app is attached to, selected or not.
    if (ev.type === "notification" && (ev as { kind?: string }).kind === "rate_limit") {
      this.rateLimitHandler?.(sessionId, (ev as { body: string }).body);
      return;
    }
    const entry = this.cache.get(sessionId);
    if (!entry) return;
    if (this.isLiveDuplicate(entry, ev)) return;
    this.recordSig(entry, ev);
    entry.events.push(ev);
    entry.subscribers.forEach((fn) => {
      try { fn(ev); } catch { /* ignore */ }
    });
  }

  /** Concatenated text of an assistant/user message, or null for others. */
  private contentText(ev: ChatEvent): string | null {
    if (ev.type !== "assistant_message" && ev.type !== "user_message") return null;
    const blocks = (ev as { content?: { type: string; text?: string }[] }).content ?? [];
    return blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  }

  /** Dedup signature, or null for events that must never be deduped (streaming
   * partials, session lifecycle, turn usage). */
  private sigOf(ev: ChatEvent): string | null {
    switch (ev.type) {
      case "assistant_message":
        // Streaming partials mutate every chunk; dedup only the finalized form.
        return ev.streaming ? null : `a:${this.contentText(ev)}`;
      case "user_message": {
        // Normalize before hashing: the file-watcher event contains the full
        // JSONL transcript (with <command-name>/<command-args> scaffolding) while
        // the synthetic push carries only the raw typed text. Without normalization
        // the sigs differ and the dedup misses, producing a duplicate bubble.
        //
        // Also strip <file:path::name> attachment tokens (sig only, never the
        // rendered text): the synthetic push carries each attachment as its own
        // text-block token, but the JSONL transcript stores the attachment as a
        // separate image block, so the text-only content differs by exactly
        // those tokens. Without this, every message WITH an attachment doubled.
        const raw = this.contentText(ev) ?? "";
        const sig = normalizeUserMessageText(raw).replace(FILE_TOKEN_SIG_RE, "").trim();
        return `u:${sig}`;
      }
      case "tool_use":
        return `tu:${ev.id}`;
      case "tool_result":
        return `tr:${ev.tool_use_id}`;
      case "notification":
        return `n:${ev.body}`;
      default:
        return null;
    }
  }

  private isLiveDuplicate(entry: CacheEntry, ev: ChatEvent): boolean {
    const now = Date.now();
    entry.recent = entry.recent.filter((r) => now - r.ts < DEDUP_WINDOW_MS);
    // A runner streaming partial whose text is a prefix of an already-delivered
    // finalized assistant (e.g. from the watcher winning the race) would render
    // a second, orphaned bubble. Suppress it so only the final survives.
    if (ev.type === "assistant_message" && ev.streaming) {
      const t = this.contentText(ev);
      if (t === null) return false;
      return entry.recent.some((r) => r.assistantFinal && r.text !== null && r.text.startsWith(t));
    }
    const sig = this.sigOf(ev);
    if (sig === null) return false;
    return entry.recent.some((r) => r.sig === sig);
  }

  private recordSig(entry: CacheEntry, ev: ChatEvent): void {
    const sig = this.sigOf(ev);
    if (sig === null) return;
    entry.recent.push({
      sig,
      text: ev.type === "assistant_message" ? this.contentText(ev) : null,
      assistantFinal: ev.type === "assistant_message" && !ev.streaming,
      ts: Date.now(),
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
      recent: [],
    };
  }

  private async ensureListener(sessionId: string): Promise<void> {
    const entry = this.cache.get(sessionId);
    if (!entry || entry.unlisten) return;
    entry.unlisten = await getTransport().listen<ChatEvent>(`chat:${sessionId}`, (payload) => {
      const cur = this.cache.get(sessionId);
      if (!cur) return;
      // claude -p --resume replays the full conversation history including past
      // user messages (remote_echo: false). Drop those to avoid duplicating
      // transcript history. Daemon-synthesised echoes carry remote_echo: true
      // and are delivered so phone-originated sends render a user bubble on
      // every client. The existing sigOf/isLiveDuplicate dedup gate handles
      // the case where a desktop pushSynthetic already recorded the same sig.
      if (payload.type === "user_message" && !(payload as { remote_echo?: boolean }).remote_echo) return;
      this.deliver(sessionId, payload);
    });
  }

  // Subscribes to chat-watch:<id> events emitted by the JSONL file watcher.
  // Unlike the runner channel, user_messages are allowed through (they come
  // from terminal input, not from claude -p re-emission). Cross-source dedup
  // (against events the runner already pushed for app-driven turns) is handled
  // by `deliver`, keyed on content within a short window - the old
  // timestamp+type key collided because live `-p` events all carry ts=0 and
  // only deduped one direction, so a watcher event that won the race against
  // the runner doubled the turn (ai_todo 77).
  async ensureWatchListener(sessionId: string): Promise<void> {
    let entry = this.cache.get(sessionId);
    if (!entry) {
      entry = this.makeEntry();
      this.cache.set(sessionId, entry);
    }
    if (entry.unlistenWatch) return;
    entry.unlistenWatch = await getTransport().listen<ChatEvent>(`chat-watch:${sessionId}`, (payload) => {
      this.deliver(sessionId, payload);
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
