import { escapeHtml } from "../../shared/escape-html";
import type { Instance } from "../../types/ipc.generated";
import { characterForSession, characterIconUrl } from "./session-characters";
import { statusDotClass } from "./sessions-helpers";

/** Inline "X% of 5h" chip shown in a row's subtitle while sorting by drain.
 *  Muted "—% of 5h" placeholder until the async drain fetch resolves. */
export function drainChipHtml(pct: number | undefined): string {
  if (pct === undefined) {
    return ` <span class="session-row-drain session-row-drain--unknown" title="Token drain (loading...)">—% of 5h</span>`;
  }
  return ` <span class="session-row-drain" title="This chat's share of your current 5h session">${Math.round(pct)}% of 5h</span>`;
}

/** Renders the project tech-icon badge (bottom-right corner of the character portrait).
 *  Shared by the sidebar rows and the session-header badge (active-session.ts). */
export function projBadgeHtml(cwd: string | null, cls: string): string {
  if (!cwd) return "";
  return `<span class="${cls}"><span class="proj-face" data-proj-face="${escapeHtml(cwd)}"><i class="ph ph-folder"></i></span></span>`;
}

/** Wrap an avatar strip + optional project badge in the positioning wrapper. */
function avatarWrap(avatarHtml: string, badge: string): string {
  return `<span class="session-avatar-wrap">${avatarHtml}${badge}</span>`;
}

/** Leading visual for a live session row: character portrait + status glow + optional project badge. */
export function leadingVisual(
  s: Instance,
  indicator: string,
  unread: Set<string>,
  attention: Set<string>,
  question: Set<string>,
  rateLimited: ReadonlySet<string> = new Set(),
): string {
  const charId = characterForSession(s);
  if (!charId) return indicator;
  const id = escapeHtml(charId);
  const st = statusDotClass(s, unread, attention, question, rateLimited);
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
  const badge = projBadgeHtml(s.cwd, "session-proj-badge");
  return avatarWrap(avatarHtml, badge);
}

/** Leading visual for a draft/parked-draft row: same structure as live rows
 * but no status glow (nothing is in flight). Falls back to a muted icon when
 * the session has no character assigned yet. */
export function draftLeadingVisual(charId: string | null | undefined, cwd: string): string {
  if (!charId) return `<i class="session-state-icon ph ph-chat-circle-dots"></i>`;
  const id = escapeHtml(charId);
  const url = characterIconUrl(charId);
  const preload = url ? ` src="${escapeHtml(url)}" data-hydrated="${id}"` : "";
  const avatarHtml = `<span class="session-avatar">
          <img class="char-avatar session-char-backdrop" data-character-id="${id}"${preload} alt="" aria-hidden="true">
          <img class="char-avatar session-char-img" data-character-id="${id}"${preload} alt="${id}">
        </span>`;
  const badge = projBadgeHtml(cwd, "session-proj-badge");
  return avatarWrap(avatarHtml, badge);
}
