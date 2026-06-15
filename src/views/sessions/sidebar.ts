import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import type { Avatar, Instance, ProjectGroup } from "../../types/ipc.generated";
import { closeChat } from "./close-chat";
import { isSessionClosing } from "./closing-sessions";
import {
  projectName,
  sessionSubtitle,
  statusIndicator,
  statusDotClass,
  sortSessions,
  loadUnreadSet,
  saveUnreadSet,
  loadSort,
  loadStateStyle,
} from "./sessions-helpers";
import { state } from "./state";
import { getChatSlotMode, getSlotAssignment } from "../../shared/shortcuts";
import { pendingPromptSessionIds, clearPendingPrompt } from "./permission-modal";
import { reconcileList, loadAnimEnabled, markSessionExiting } from "./sidebar-anim";
import { characterForSession, characterIconUrl } from "./session-characters";
import { hydrateCharacterAvatars } from "../../shared/projects";

// ── Project avatar cache ─────────────────────────────────────────────────────
// Keyed by normalised (lowercased) cwd so Windows path casing doesn't matter.
let _projectAvatarByPath: Map<string, Avatar> = new Map();

export async function loadProjectAvatars(): Promise<void> {
  try {
    const groups = await invoke<ProjectGroup[]>("list_project_groups");
    const next = new Map<string, Avatar>();
    for (const g of groups) {
      if (g.avatar.kind !== "none") next.set(g.path.toLowerCase(), g.avatar);
    }
    _projectAvatarByPath = next;
  } catch {
    // non-fatal; badge just won't appear
  }
}

export function getProjectAvatarForCwd(cwd: string): Avatar | null {
  return _projectAvatarByPath.get(cwd.toLowerCase()) ?? null;
}

/** Renders the project avatar as a badge span, or empty string when none. */
function projBadgeHtml(avatar: Avatar | null, cls: string): string {
  if (!avatar || avatar.kind === "none") return "";
  if (avatar.kind === "emoji") {
    return `<span class="${cls}" aria-hidden="true">${escapeHtml(avatar.value)}</span>`;
  }
  if (avatar.kind === "image") {
    const src = escapeHtml(`file:///${avatar.value.replaceAll("\\", "/")}`);
    return `<span class="${cls}"><img src="${src}" alt="" style="width:100%;height:100%;object-fit:cover"></span>`;
  }
  if (avatar.kind === "character") {
    const id = escapeHtml(avatar.value);
    return `<span class="${cls}"><img class="char-avatar" data-character-id="${id}" alt="" style="width:100%;height:100%;object-fit:cover;image-rendering:pixelated"></span>`;
  }
  return "";
}

/** Wrap an avatar strip + optional project badge in the positioning wrapper. */
function avatarWrap(avatarHtml: string, badge: string): string {
  return `<span class="session-avatar-wrap">${avatarHtml}${badge}</span>`;
}

/** Leading visual for a live session row: character portrait + status glow + optional project badge. */
function leadingVisual(
  s: Instance,
  indicator: string,
  unread: Set<string>,
  attention: Set<string>,
  question: Set<string>,
): string {
  const charId = characterForSession(s);
  if (!charId) return indicator;
  const id = escapeHtml(charId);
  const st = statusDotClass(s, unread, attention, question);
  const url = characterIconUrl(charId);
  // Inline the preloaded data URL so the image is filled on first paint and
  // doesn't flash broken when the row is rebuilt. data-hydrated makes the
  // post-render hydrate pass a no-op for already-filled images.
  const preload = url ? ` src="${escapeHtml(url)}" data-hydrated="${id}"` : "";
  // Two layers share the same src so the single hydrate pass fills both:
  //  - backdrop: same art blurred + scaled to cover, fills the strip edge to
  //    edge so a transparent (hexagonal) portrait's corners reveal blurred hero
  //    colours instead of the row background — no hexagon silhouette.
  //  - foreground: the sharp portrait on top.
  const avatarHtml = `<span class="session-avatar ${st}">
          <img class="char-avatar session-char-backdrop" data-character-id="${id}"${preload} alt="" aria-hidden="true">
          <img class="char-avatar session-char-img" data-character-id="${id}"${preload} alt="${id}">
        </span>`;
  const badge = projBadgeHtml(getProjectAvatarForCwd(s.cwd), "session-proj-badge");
  return avatarWrap(avatarHtml, badge);
}

/** Leading visual for a draft/parked-draft row: same structure as live rows
 * but no status glow (nothing is in flight). Falls back to a muted icon when
 * the session has no character assigned yet. */
function draftLeadingVisual(charId: string | null | undefined, cwd: string): string {
  if (!charId) return `<i class="session-state-icon ph ph-chat-circle-dots"></i>`;
  const id = escapeHtml(charId);
  const url = characterIconUrl(charId);
  const preload = url ? ` src="${escapeHtml(url)}" data-hydrated="${id}"` : "";
  const avatarHtml = `<span class="session-avatar">
          <img class="char-avatar session-char-backdrop" data-character-id="${id}"${preload} alt="" aria-hidden="true">
          <img class="char-avatar session-char-img" data-character-id="${id}"${preload} alt="${id}">
        </span>`;
  const badge = projBadgeHtml(getProjectAvatarForCwd(cwd), "session-proj-badge");
  return avatarWrap(avatarHtml, badge);
}

export function isLive(i: Instance): boolean {
  return !i.ended_at && (i.kind === "interactive" || i.kind === "external" || i.kind === "automated");
}

export async function refreshSessions(): Promise<void> {
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
    // and are not currently open/selected. For the ACTIVE session, the same
    // transition is the auto-flush trigger for any held messages (unless Claude
    // stopped to ask, in which case the held set waits for the answer).
    for (const s of next) {
      const wasBusy = state.prevBusyMap.get(s.session_id);
      if (wasBusy === true && !s.busy) {
        if (s.session_id !== state.selectedId) {
          unread.add(s.session_id);
        } else {
          const isQuestion = !!s.awaiting || state.questionSessions.has(s.session_id);
          state.heldMessages?.onCompletion(s.session_id, isQuestion);
        }
      }
    }

    // Update prevBusyMap for next call
    state.prevBusyMap = new Map(next.map(s => [s.session_id, s.busy]));

    saveUnreadSet(unread);
    state.sessions = next;
  } catch (err) {
    console.error("[sessions] list_instances failed", err);
    state.sessions = [];
  }
}

export function renderSidebar(listEl: HTMLElement): void {
  const filter = state.filter.toLowerCase();
  const pending = state.pendingNewSession;
  const unread = loadUnreadSet();
  const attention = pendingPromptSessionIds();
  // Union: renderer-detected (opened sessions) + registry-backed (all sessions incl. background).
  const question = new Set<string>([
    ...state.questionSessions,
    ...state.sessions.filter(s => s.awaiting === "question").map(s => s.session_id),
  ]);
  const style = loadStateStyle();
  const sort = loadSort();

  let visible = state.sessions;
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

  const sorted = sortSessions(filtered, sort, unread, attention, question);
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
            <span class="session-row-project">${escapeHtml(pending.projectName || "New session")}</span>
            <span class="session-row-subtitle">Draft New Chat</span>
          </div>
          <button class="session-row-menu-btn icon-btn" title="Discard draft" data-discard-draft="1">
            <i class="ph ph-x-circle"></i>
          </button>
        </li>`
      : `<li class="${activeCls} pending" data-pending="1" data-placeholder-id="${pid}" title="Starting new session... click X to discard if stuck">
          ${draftLeadingVisual(pending.config.characterId, pending.projectPath)}
          <div class="session-row-text">
            <span class="session-row-project">${escapeHtml(pending.projectName || "New session")}</span>
            <span class="session-row-subtitle">starting...</span>
          </div>
          <button class="session-row-menu-btn icon-btn" title="Discard stuck session" data-discard-stuck="1">
            <i class="ph ph-x-circle"></i>
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
          <span class="session-row-project">${escapeHtml(d.projectName || "New session")}</span>
          <span class="session-row-subtitle">Draft New Chat</span>
        </div>
        <button class="session-row-menu-btn icon-btn" title="Discard draft" data-discard-parked="${escapeHtml(d.placeholderId)}">
          <i class="ph ph-x-circle"></i>
        </button>
      </li>`,
    });
  }

  for (const [i, s] of sorted.entries()) {
    const isActive = s.session_id === state.selectedId;
    const needsAttention = attention.has(s.session_id);
    const isClosing = isSessionClosing(s.session_id);
    const indicator = statusIndicator(s, unread, attention, question, style, escapeHtml);
    let kbdHint = "";
    if (isManualSlots) {
      const slot = slotBySession[s.session_id];
      if (slot) kbdHint = ` data-kbd-hint="${slot}"`;
    } else {
      if (i < 9) kbdHint = ` data-kbd-hint="${i + 1}"`;
    }
    entries.push({
      key: `s:${s.session_id}`,
      html: `<li data-session-id="${escapeHtml(s.session_id)}"${kbdHint} class="${isActive ? "active" : ""} ${s.kind === "external" ? "is-external" : ""} ${needsAttention ? "needs-attention" : ""} ${isClosing ? "closing" : ""}">
        ${leadingVisual(s, indicator, unread, attention, question)}
        <div class="session-row-text">
          <span class="session-row-project">${escapeHtml(projectName(s))}</span>
          <span class="session-row-subtitle">${escapeHtml(sessionSubtitle(s))}</span>
        </div>
        <button class="session-row-menu-btn icon-btn" title="More options" data-session-id="${escapeHtml(s.session_id)}">
          <i class="ph ph-dots-three-vertical"></i>
        </button>
      </li>`,
    });
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

  reconcileList(listEl, entries, loadAnimEnabled());
  // Resolve hero avatar images to data URLs (idempotent per character id).
  void hydrateCharacterAvatars(listEl);
}

// ── Per-row 3-dot context menu ───────────────────────────────────────────────

let activeCtxMenu: HTMLElement | null = null;

export function closeCtxMenu(): void {
  if (activeCtxMenu) {
    activeCtxMenu.remove();
    activeCtxMenu = null;
  }
}

export interface CtxMenuActions {
  /** "New agent here" — start a new session in this row's cwd. */
  onNewHere: (project: { path: string; name: string }) => void;
}

export function openCtxMenu(
  sessionId: string,
  anchor: HTMLElement,
  actions: CtxMenuActions,
): void {
  closeCtxMenu();

  const sess = state.sessions.find(s => s.session_id === sessionId);
  if (!sess) return;

  const menu = document.createElement("div");
  menu.className = "session-ctx-menu";

  // "New agent here"
  const newItem = document.createElement("button");
  newItem.className = "session-ctx-item";
  newItem.innerHTML = '<i class="ph ph-plus"></i> New agent here';
  newItem.addEventListener("click", () => {
    closeCtxMenu();
    actions.onNewHere({ path: String(sess.cwd), name: projectName(sess) });
  });
  menu.appendChild(newItem);

  // "Open project in dashboard" — focuses (or opens) the main window and
  // navigates to this session's project detail view.
  if (sess.cwd) {
    const sessCwd = String(sess.cwd);
    const dashItem = document.createElement("button");
    dashItem.className = "session-ctx-item";
    dashItem.innerHTML = '<i class="ph ph-squares-four"></i> Open project in dashboard';
    dashItem.addEventListener("click", async () => {
      closeCtxMenu();
      try {
        await invoke<void>("open_dashboard_project", { cwd: sessCwd });
      } catch (e) {
        console.error("[ctx-menu] open_dashboard_project failed", e);
      }
    });
    menu.appendChild(dashItem);
  }

  // "Open in VS Code"
  const codeItem = document.createElement("button");
  codeItem.className = "session-ctx-item";
  codeItem.innerHTML = '<i class="ph ph-code"></i> Open in VS Code';
  codeItem.addEventListener("click", async () => {
    closeCtxMenu();
    try {
      await invoke<void>("open_in_vscode", { path: String(sess.cwd) });
    } catch {
      /* silently ignore — code may not be installed */
    }
  });
  menu.appendChild(codeItem);

  // "Copy PID" — only if session has a pid
  if (sess.pid) {
    const pidItem = document.createElement("button");
    pidItem.className = "session-ctx-item";
    pidItem.innerHTML = '<i class="ph ph-copy"></i> Copy PID';
    pidItem.addEventListener("click", () => {
      closeCtxMenu();
      void navigator.clipboard.writeText(String(sess.pid));
    });
    menu.appendChild(pidItem);
  }

  // "Close" — kills the underlying claude process (per-turn child for
  // interactive sessions, the user's terminal claude pid for external)
  // and drops the row from the sidebar. clear_session handles both kinds.
  const closeItem = document.createElement("button");
  closeItem.className = "session-ctx-item";
  const closeLabel = sess.kind === "external" ? "Close (kill terminal)" : "Close";
  closeItem.innerHTML = `<i class="ph ph-x"></i> ${closeLabel}`;
  closeItem.addEventListener("click", () => {
    closeCtxMenu();
    const listEl = anchor.closest<HTMLElement>("#sessions-list");
    if (listEl && loadAnimEnabled()) markSessionExiting(listEl, sessionId);
    void closeChat(sessionId);
  });
  menu.appendChild(closeItem);

  document.body.appendChild(menu);
  activeCtxMenu = menu;

  // Position below the anchor button, right-aligned
  const rect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let top = rect.bottom + 4;
  let left = rect.right - menuRect.width;
  if (left < 4) left = 4;
  if (top + menuRect.height > window.innerHeight - 4) top = rect.top - menuRect.height - 4;
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
}

// Close context menu on outside click or Escape (wired once at module load)
document.addEventListener("click", (e) => {
  if (activeCtxMenu && !activeCtxMenu.contains(e.target as Node)) {
    closeCtxMenu();
  }
}, true);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && activeCtxMenu) closeCtxMenu();
});
