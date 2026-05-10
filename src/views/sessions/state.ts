import type { Instance } from "../../types/ipc.generated";
import type { ChatRenderer } from "../../shared/chat/chat-renderer";
import type { Composer } from "../../shared/chat/composer";
import { setSelectedSessionId } from "./permission-modal";
import type { SessionStatusbar } from "./session-statusbar";

export interface PendingNewSession {
  placeholderId: string;
  projectPath: string;
  projectName: string;
  // Once the real session_id is captured from the first SessionStarted event,
  // we record it here so refreshSessions/renderSidebar can suppress the real
  // entry from the registry list (the pending row, now upgraded, represents
  // it). Cleared when start_session resolves.
  realId: string | null;
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

/**
 * Single point of truth for the active session id. Mutating
 * `state.selectedId` directly without notifying permission-modal would
 * silently gate-out modals for the new session. Always go through this
 * helper.
 */
export function setActiveSession(id: string | null): void {
  state.selectedId = id;
  setSelectedSessionId(id);
}
