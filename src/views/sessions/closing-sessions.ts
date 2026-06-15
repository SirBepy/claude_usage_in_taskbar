// Tracks sessions that are mid-`/close`: the retrospective skill is running in
// the background and the chat will be fully ended (process killed) when its
// turn completes. The sidebar paints these rows with a "closing" state so the
// chat stays visible (not yanked away) until it is actually dead. See the
// `/close` branch in active-session.ts and the `.closing` style in sessions.css.

const _closing = new Set<string>();

export function markSessionClosing(id: string): void {
  _closing.add(id);
}

export function unmarkSessionClosing(id: string): void {
  _closing.delete(id);
}

export function isSessionClosing(id: string): boolean {
  return _closing.has(id);
}
