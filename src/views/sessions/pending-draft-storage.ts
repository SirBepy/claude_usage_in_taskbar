import type { PendingNewSession } from "./state";

export const PENDING_SESSION_KEY = "pending-session:v1";

export function savePendingSession(pending: PendingNewSession): void {
  try {
    const serialized = {
      placeholderId: pending.placeholderId,
      projectPath: pending.projectPath,
      projectName: pending.projectName,
      config: pending.config,
      realId: pending.realId,
      firstMessageSent: pending.firstMessageSent,
      preExistingSessionIds: Array.from(pending.preExistingSessionIds),
      firstMessageSentAt: pending.firstMessageSentAt,
    };
    localStorage.setItem(PENDING_SESSION_KEY, JSON.stringify(serialized));
  } catch {
    /* quota or storage disabled */
  }
}

export function loadPendingSession(): PendingNewSession | null {
  try {
    const raw = localStorage.getItem(PENDING_SESSION_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return {
      placeholderId: obj.placeholderId,
      projectPath: obj.projectPath,
      projectName: obj.projectName,
      config: obj.config,
      realId: obj.realId,
      firstMessageSent: obj.firstMessageSent,
      preExistingSessionIds: new Set(obj.preExistingSessionIds),
      firstMessageSentAt: obj.firstMessageSentAt ?? null,
    };
  } catch {
    return null;
  }
}

export function clearPendingSession(): void {
  try {
    localStorage.removeItem(PENDING_SESSION_KEY);
  } catch {
    /* ignore */
  }
}
