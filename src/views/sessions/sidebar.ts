import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import type { Instance, DrainBoard } from "../../types/ipc.generated";
import { isSessionClosing, getClosingSet } from "./closing-sessions";
import {
  projectName,
  sessionSubtitle,
  statusIndicator,
  sortSessions,
  sessionSegment,
  deriveQuestionSet,
  loadUnreadSet,
  saveUnreadSet,
  loadSort,
  loadStateStyle,
  loadHiddenSessions,
  saveHiddenSessions,
  loadHiddenCollapsed,
  isSegCollapsed,
  resetSegCollapse,
} from "./sessions-helpers";
import { state } from "./state";
import { getChatSlotMode, getSlotAssignment } from "../../shared/shortcuts";
import { pendingPromptSessionIds, clearPendingPrompt } from "./permission-modal";
import { reconcileList, loadAnimEnabled } from "./sidebar-anim";
import { hydrateCharacterAvatars, hydrateProjectTechIcons } from "../../shared/projects";
import { isBlocked } from "../../shared/chat/rate-limit-banner";
import { setRerenderCallback } from "./sidebar-ctx-menu";
import { drainChipHtml, leadingVisual, draftLeadingVisual } from "./sidebar-row-visuals";
export { closeCtxMenu, openDraftCtxMenu, openCtxMenu } from "./sidebar-ctx-menu";

let sidebarListEl: HTMLElement | null = null;

// ── Token-drain data (for the "Token drain" sort) ────────────────────────────
//
// sessionId -> fiveHourPct (this chat's share of the current 5h session). Filled
// lazily by refreshDrainMap, which is ONLY kicked when the active sort is
// "drain". renderSidebar runs frequently and synchronously, so it must never
// block on (or unconditionally fire) the chat_drains IPC — it reads whatever
// drainMap already has and triggers an async, debounced background refresh.
const drainMap = new Map<string, number>();
let drainFetchInFlight = false;
let drainLastFetchMs = 0;
const DRAIN_REFRESH_DEBOUNCE_MS = 3000;

/** Lazily refresh the per-session drain percentages, then re-render ONCE.
 *  Debounced: skips if a fetch is in flight or one ran within the last ~3s. */
function refreshDrainMap(sessionIds: string[]): void {
  if (drainFetchInFlight) return;
  if (Date.now() - drainLastFetchMs < DRAIN_REFRESH_DEBOUNCE_MS) return;
  if (sessionIds.length === 0) return;
  drainFetchInFlight = true;
  void (async () => {
    try {
      const board = await invoke<DrainBoard>("chat_drains", { sessionIds });
      for (const id of sessionIds) {
        const chat = board.chats[id];
        // null share = no usage snapshot yet; leave it out so the row keeps the
        // "—% of 5h" placeholder rather than rendering a misleading 0%.
        if (chat && chat.fiveHourPct !== null) drainMap.set(id, chat.fiveHourPct);
      }
      drainLastFetchMs = Date.now();
      // Re-render with the fresh data. Guard on a still-mounted list element.
      if (sidebarListEl) renderSidebar(sidebarListEl);
    } catch (err) {
      console.error("[sidebar] chat_drains failed", err);
    } finally {
      drainFetchInFlight = false;
    }
  })();
}

export function isLive(i: Instance): boolean {
  return !i.ended_at && (i.kind === "interactive" || i.kind === "external" || i.kind === "automated");
}

/**
 * Re-fetch the live session list into `state.sessions`. Returns whether the
 * `list_instances` IPC actually succeeded: on failure the catch below empties
 * `state.sessions` (pre-existing behavior the sidebar render relies on), which
 * is indistinguishable from "everything genuinely ended" to callers that diff
 * the list - the event-store eviction hooks in sessions.ts MUST skip their
 * ended-session diff on a failed refresh or a transient IPC blip would evict
 * every cached background transcript. Existing callers ignore the return.
 */
export async function refreshSessions(): Promise<boolean> {
  try {
    const all = await invoke<Instance[]>("list_instances");
    const next = (all || []).filter(isLive);

    const unread = loadUnreadSet();
    const liveIds = new Set(next.map(s => s.session_id));

    // GC: prune unread entries for sessions no longer alive
    for (const id of [...unread]) {
      if (!liveIds.has(id)) unread.delete(id);
    }

    // GC: drop parked permission/question prompts for dead sessions (e.g. the
    // chat was closed before the user switched back to answer).
    for (const id of pendingPromptSessionIds()) {
      if (!liveIds.has(id)) clearPendingPrompt(id);
    }

    // Mark unread for sessions that just finished a busy turn (busy true->false)
    // and are not currently open/selected.
    for (const s of next) {
      const wasBusy = state.prevBusyMap.get(s.session_id);
      if (wasBusy === true && !s.busy && s.session_id !== state.selectedId) {
        unread.add(s.session_id);
      }
    }

    // Auto-flush held messages for the ACTIVE session whenever it's idle with
    // something staged (unless Claude stopped to ask, in which case the held
    // set waits for the answer). Checked on every refresh rather than only on
    // the busy->false edge: the busy flag (instances-changed) and the chat
    // message stream (which derives questionSessions from the cc-status
    // marker) are separate, independently-lossy channels, so a one-shot edge
    // check can race and permanently strand a held message. onCompletion() is
    // idempotent (no-ops once the held set is empty), so re-checking on every
    // tick — including right after switching back to a chat that finished
    // while it wasn't selected — is safe.
    const active = next.find(s => s.session_id === state.selectedId);
    if (active && !active.busy && state.heldMessages?.hasItemsForActive()) {
      const isQuestion = active.awaiting === "question";
      state.heldMessages.onCompletion(active.session_id, isQuestion);
    }

    // Auto-flush held messages for BACKGROUNDED idle sessions too: a message
    // queued in chat A must send the moment A's turn finishes, even while a
    // different chat stays on screen. Same question gate as the active path,
    // evaluated per session; send_message is a plain IPC call, so no pane
    // needs to be mounted. flushBackground clears the held set before the
    // async send, so it can't double-fire against the reselect flush in
    // active-session.ts (which no-ops on an empty set).
    for (const s of next) {
      if (s.session_id === state.selectedId || s.busy) continue;
      if (!state.heldMessages?.hasItemsFor(s.session_id)) continue;
      const isQuestion = s.awaiting === "question";
      if (isQuestion) continue;
      const sid = s.session_id;
      const cwd = s.cwd;
      void state.heldMessages.flushBackground(sid, (blocks) =>
        invoke<void>("send_message", { sessionId: sid, cwd, blocks }),
      );
    }

    // Update prevBusyMap for next call
    state.prevBusyMap = new Map(next.map(s => [s.session_id, s.busy]));

    saveUnreadSet(unread);
    state.sessions = next;
    return true;
  } catch (err) {
    console.error("[sessions] list_instances failed", err);
    state.sessions = [];
    return false;
  }
}

export function renderSidebar(listEl: HTMLElement): void {
  sidebarListEl = listEl;
  setRerenderCallback(() => renderSidebar(listEl));

  const filter = state.filter.toLowerCase();
  const pending = state.pendingNewSession;
  const unread = loadUnreadSet();
  // The viewed chat's parked prompt is already shown as a card; don't also flag
  // its row with the attention alarm (backgrounded parked prompts still badge).
  const attention = pendingPromptSessionIds();
  if (state.selectedId) attention.delete(state.selectedId);
  // Registry-backed only (see deriveQuestionSet): one source of truth for the
  // question flag, covering background sessions too.
  const question = deriveQuestionSet(state.sessions);
  const style = loadStateStyle();
  const sort = loadSort();
  const rateLimited = new Set(state.sessions.filter(isBlocked).map((s) => s.session_id));

  // Load hidden set and prune stale IDs
  const hidden = loadHiddenSessions();
  const liveIds = new Set(state.sessions.map(s => s.session_id));
  let hiddenPruned = false;
  for (const id of [...hidden]) {
    if (!liveIds.has(id)) { hidden.delete(id); hiddenPruned = true; }
  }
  if (hiddenPruned) saveHiddenSessions(hidden);

  const hiddenSessions = state.sessions.filter(s => hidden.has(s.session_id));

  let visible = state.sessions.filter(s => !hidden.has(s.session_id));
  if (pending?.realId) {
    visible = visible.filter(s => s.session_id !== pending.realId);
  } else if (pending) {
    // Pre-resolution window: the SessionStart hook on our own `claude -p`
    // spawn registers an External entry before chat IPC captures the real
    // session_id. Hide that newcomer row so it doesn't double-render
    // alongside the pending placeholder. Pre-existing sessions in the same
    // cwd stay visible.
    visible = visible.filter(s =>
      !(String(s.cwd) === pending.projectPath && !pending.preExistingSessionIds.has(s.session_id))
    );
  }

  const filtered = visible.filter(s =>
    !filter ||
    projectName(s).toLowerCase().includes(filter) ||
    sessionSubtitle(s).toLowerCase().includes(filter)
  );

  const closing = getClosingSet();
  // Only fetch token-drain data when the user is actually sorting by it. Fire
  // the (debounced) async refresh in the background; render now with whatever
  // drainMap already holds so render never blocks on the IPC.
  if (sort === "drain") {
    refreshDrainMap(filtered.map(s => s.session_id));
  }
  const sorted = sortSessions(filtered, sort, unread, attention, question, closing, drainMap);
  state.sortedSessionIds = sorted.map(s => s.session_id);

  const isManualSlots = getChatSlotMode() === "manual";
  const slotBySession: Record<string, number> = {};
  if (isManualSlots) {
    for (let slot = 1; slot <= 9; slot++) {
      const sid = getSlotAssignment(slot);
      if (sid) slotBySession[sid] = slot;
    }
  }

  const entries: Array<{ key: string; html: string }> = [];

  if (pending || state.parkedDrafts.length > 0) {
    entries.push({
      key: "__seg:draft__",
      html: `<li class="session-group-header" data-row-key="__seg:draft__">Draft</li>`,
    });
  }

  if (pending) {
    const isPendingActive = state.selectedId === pending.placeholderId;
    const activeCls = isPendingActive ? "active" : "";
    // Key by placeholderId, NOT a constant "pending": consecutive drafts must
    // have distinct keys. A constant key let a just-discarded draft's exit
    // suppression (exitingKeys) leak onto the next draft, so the new draft was
    // filtered out and never rendered until its key changed (i.e. a message
    // turned it into a real session). The li carries data-placeholder-id so
    // keyOf() in sidebar-anim derives the matching `p:<id>` key.
    const pid = escapeHtml(pending.placeholderId);
    const html = !pending.firstMessageSent
      ? `<li class="${activeCls} pending draft" data-pending="1" data-placeholder-id="${pid}" title="Draft — type a message to start">
          ${draftLeadingVisual(pending.config.characterId, pending.projectPath)}
          <div class="session-row-text">
            <span class="session-row-project">Draft New Chat</span>
            <span class="session-row-subtitle">${escapeHtml(pending.projectName || "New session")}</span>
          </div>
          <button class="session-row-menu-btn icon-btn" title="Draft options" data-draft-menu="1">
            <i class="ph ph-dots-three-vertical"></i>
          </button>
        </li>`
      : `<li class="${activeCls} pending" data-pending="1" data-placeholder-id="${pid}" title="Starting new session... click X to discard if stuck">
          ${draftLeadingVisual(pending.config.characterId, pending.projectPath)}
          <div class="session-row-text">
            <span class="session-row-project">starting...</span>
            <span class="session-row-subtitle">${escapeHtml(pending.projectName || "New session")}</span>
          </div>
          <button class="session-row-menu-btn icon-btn" title="Draft options" data-draft-menu="1">
            <i class="ph ph-dots-three-vertical"></i>
          </button>
        </li>`;
    entries.push({ key: `p:${pending.placeholderId}`, html });
  }

  for (const d of state.parkedDrafts) {
    entries.push({
      key: `p:${d.placeholderId}`,
      html: `<li class="parked-draft" data-placeholder-id="${escapeHtml(d.placeholderId)}" title="Parked draft — click to resume">
        ${draftLeadingVisual(d.config.characterId, d.projectPath)}
        <div class="session-row-text">
          <span class="session-row-project">Draft New Chat</span>
          <span class="session-row-subtitle">${escapeHtml(d.projectName || "New session")}</span>
        </div>
        <button class="session-row-menu-btn icon-btn" title="Draft options" data-parked-placeholder-id="${escapeHtml(d.placeholderId)}">
          <i class="ph ph-dots-three-vertical"></i>
        </button>
      </li>`,
    });
  }

  const SEGMENT_LABELS = ["Input Needed", "Done", "In Progress", "Closing", "Waiting for Reset", "Waiting"];
  const segmented: Map<number, typeof sorted> = new Map([[0, []], [1, []], [2, []], [3, []], [4, []], [5, []]]);
  for (const s of sorted) {
    segmented.get(sessionSegment(s, unread, attention, question, closing, rateLimited))!.push(s);
  }

  let sessionIndex = 0;
  // "Waiting" (5, parked on an external process) renders right after
  // "In Progress" (2) so the blocked-on-a-script chats sit next to the
  // actively-running ones without disturbing the other groups' order.
  for (const seg of [0, 1, 2, 5, 3, 4]) {
    const group = segmented.get(seg)!;
    if (group.length === 0) {
      resetSegCollapse(seg);
      continue;
    }
    const segCollapsed = isSegCollapsed(seg);
    const chevronCls = segCollapsed ? "ph-caret-right" : "ph-caret-down";
    entries.push({
      key: `__seg:${seg}__`,
      html: `<li class="session-group-header session-group-seg-toggle" data-seg-toggle="${seg}" data-row-key="__seg:${seg}__">
        <i class="ph ${chevronCls}" style="margin-right:4px;font-size:10px;vertical-align:middle"></i>${SEGMENT_LABELS[seg]}
      </li>`,
    });
    if (!segCollapsed) {
      for (const s of group) {
        const i = sessionIndex++;
        const isActive = s.session_id === state.selectedId;
        const needsAttention = attention.has(s.session_id);
        const isClosing = isSessionClosing(s.session_id);
        const indicator = statusIndicator(s, unread, attention, question, style, escapeHtml, rateLimited);
        let kbdHint = "";
        if (isManualSlots) {
          const slot = slotBySession[s.session_id];
          if (slot) kbdHint = ` data-kbd-hint="${slot}"`;
        } else {
          if (i < 9) kbdHint = ` data-kbd-hint="${i + 1}"`;
        }
        entries.push({
          key: `s:${s.session_id}`,
          html: `<li data-session-id="${escapeHtml(s.session_id)}"${kbdHint} class="${isActive ? "active" : ""} ${s.kind === "external" ? "is-external" : ""} ${needsAttention ? "needs-attention" : ""} ${isClosing ? "closing" : ""} ${rateLimited.has(s.session_id) ? "is-rate-limited" : ""}">
            ${leadingVisual(s, indicator, unread, attention, question, rateLimited)}
            <div class="session-row-text">
              <span class="session-row-project">${escapeHtml(sessionSubtitle(s))}${s.is_remote ? `<i class="ph ph-device-mobile session-remote-badge" title="Remote chat"></i>` : ""}${s.autopilot ? `<span class="autopilot-badge" title="Autopilot active">autopilot</span>` : ""}</span>
              <span class="session-row-subtitle">${escapeHtml(projectName(s))}${sort === "drain" ? drainChipHtml(drainMap.get(s.session_id)) : ""}</span>
            </div>
            <button class="session-row-menu-btn icon-btn" title="More options" data-session-id="${escapeHtml(s.session_id)}">
              <i class="ph ph-dots-three-vertical"></i>
            </button>
          </li>`,
        });
      }
    }
  }

  if (entries.length === 0 && state.daemonConnected === true) {
    // While the daemon is NOT connected the pane shows the centered
    // "Setting up..." / stalled state (paneEmptyStateHtml); the sidebar
    // stays blank rather than duplicating it in a cramped row.
    entries.push({
      key: "__empty__",
      html: `<li class="sessions-empty-row" data-row-key="__empty__"><i class="ph ph-chat-circle-dots"></i>No active sessions</li>`,
    });
  }

  // Hidden section - always at the bottom
  if (hiddenSessions.length > 0) {
    const hiddenCollapsed = loadHiddenCollapsed();
    const chevronCls = hiddenCollapsed ? "ph-caret-right" : "ph-caret-down";
    entries.push({
      key: "__seg:hidden__",
      html: `<li class="session-group-header session-group-hidden-toggle" data-hidden-toggle="1" data-row-key="__seg:hidden__">
        <i class="ph ${chevronCls}" style="margin-right:4px;font-size:10px;vertical-align:middle"></i>Hidden (${hiddenSessions.length})
      </li>`,
    });
    if (!hiddenCollapsed) {
      for (const s of hiddenSessions) {
        const isActive = s.session_id === state.selectedId;
        const indicator = statusIndicator(s, unread, attention, question, style, escapeHtml, rateLimited);
        entries.push({
          key: `s:${s.session_id}`,
          html: `<li data-session-id="${escapeHtml(s.session_id)}" class="${isActive ? "active" : ""} ${s.kind === "external" ? "is-external" : ""}">
            ${leadingVisual(s, indicator, unread, attention, question, rateLimited)}
            <div class="session-row-text">
              <span class="session-row-project">${escapeHtml(sessionSubtitle(s))}</span>
              <span class="session-row-subtitle">${escapeHtml(projectName(s))}</span>
            </div>
            <button class="session-row-menu-btn icon-btn" title="More options" data-session-id="${escapeHtml(s.session_id)}">
              <i class="ph ph-dots-three-vertical"></i>
            </button>
          </li>`,
        });
      }
    }
  }

  reconcileList(listEl, entries, loadAnimEnabled());
  // Resolve hero avatar images to data URLs (idempotent per character id).
  void hydrateCharacterAvatars(listEl);
  void hydrateProjectTechIcons(listEl);
}

