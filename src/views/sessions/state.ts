import type { Instance } from "../../types/ipc.generated";
import type { ChatRenderer } from "../../shared/chat/chat-renderer";
import type { Composer } from "../../shared/chat/composer";
import { setSelectedSessionId } from "./permission-modal";
import type { SessionStatusbar } from "./session-statusbar";
import type { SessionConfig } from "./model-effort-modal";

export interface PendingNewSession {
  placeholderId: string;
  projectPath: string;
  projectName: string;
  // Model + effort chosen via openModelEffortModal at launch. Stored so we
  // can re-render the pending pane on resume after the user navigates away.
  config: SessionConfig;
  // Once the real session_id is captured from the first SessionStarted event,
  // we record it here so refreshSessions/renderSidebar can suppress the real
  // entry from the registry list (the pending row, now upgraded, represents
  // it). Cleared when start_session resolves.
  realId: string | null;
  // False between `+ New chat` and the user actually sending the first
  // message. While false, sidebar shows a draft row (no spinner) and the
  // thinking bar stays hidden — no work is in flight yet.
  firstMessageSent: boolean;
  // Snapshot of session_ids that existed in `state.sessions` at the moment
  // this pending entry was created. Sidebar uses it to filter out only the
  // *newcomer* row whose cwd matches `projectPath` (i.e. our own claude -p
  // spawn registered as External by the SessionStart hook before our chat
  // IPC captures the real session_id). Pre-existing rows in the same cwd
  // stay visible.
  preExistingSessionIds: Set<string>;
  // Wall-clock ms when firstMessageSent flipped to true. Used at restore
  // time to auto-discard pending entries whose start_session RPC died with
  // the previous app instance (firstMessageSent && !realId && stale).
  firstMessageSentAt: number | null;
}

export interface SessionsState {
  mountId: number;
  sessions: Instance[];
  selectedId: string | null;
  filter: string;
  renderer: ChatRenderer | null;
  composer: Composer | null;
  unlistenInstances: (() => void) | null;
  pendingNewSession: PendingNewSession | null;
  statusbar: SessionStatusbar | null;
  prevBusyMap: Map<string, boolean>;
  sortedSessionIds: string[];
}

export function createInitialState(mountId: number): SessionsState {
  return {
    mountId,
    sessions: [],
    selectedId: null,
    filter: "",
    renderer: null,
    composer: null,
    unlistenInstances: null,
    pendingNewSession: null,
    statusbar: null,
    prevBusyMap: new Map(),
    sortedSessionIds: [],
  };
}

// Module-level singleton. mountId protects against stale-mount writes when
// the user rapid-fires view switches: every async callback reads the current
// state.mountId and bails if it no longer matches the captured id.
export let state: SessionsState = createInitialState(0);

let _nextMountId = 1;

/**
 * Allocate a fresh mountId and replace the module-level state singleton with
 * a clean record bound to that mountId. Returns the new mountId so callers
 * can capture it for stale-write checks (`if (state.mountId !== myMount)`).
 */
export function resetState(): number {
  const id = _nextMountId++;
  state = createInitialState(id);
  return id;
}

const LS_LAST_SELECTED = "cc_last_selected_session";

/**
 * Single point of truth for the active session id. Mutating
 * `state.selectedId` directly without notifying permission-modal would
 * silently gate-out modals for the new session. Always go through this
 * helper.
 *
 * Side-effect: persists the id to localStorage so the next mount can
 * restore the last-viewed chat after a reload / app restart. Pending
 * placeholder ids (prefix "pending-") are not persisted - they are tracked
 * via the separate pending-session storage in pending-flow.ts.
 */
export function setActiveSession(id: string | null): void {
  state.selectedId = id;
  setSelectedSessionId(id);
  try {
    if (id && !id.startsWith("pending-")) {
      localStorage.setItem(LS_LAST_SELECTED, id);
    } else if (id === null) {
      localStorage.removeItem(LS_LAST_SELECTED);
    }
  } catch {
    /* quota or storage disabled */
  }
}

export function loadLastSelectedSession(): string | null {
  try {
    return localStorage.getItem(LS_LAST_SELECTED);
  } catch {
    return null;
  }
}
