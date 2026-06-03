export const LS_ANIM = "cc_sidebar_animations";

export function loadAnimEnabled(): boolean {
  try { return localStorage.getItem(LS_ANIM) !== "off"; } catch { return true; }
}

function keyOf(li: HTMLLIElement): string {
  if (li.dataset.sessionId) return `s:${li.dataset.sessionId}`;
  if (li.dataset.placeholderId) return `p:${li.dataset.placeholderId}`;
  if (li.classList.contains("pending")) return "pending";
  return "";
}

// Keys already committed to exiting — filtered out of entries on every reconcile.
const exitingKeys = new Set<string>();

// Per-node safety-removal timers. An exiting row is normally removed on its own
// `animationend`. Because the row is taken OUT of layout flow the instant it
// starts exiting (see beginExit), removing it can no longer reflow its
// siblings, so `animationend` removal is safe — there is no flash-back to
// guard against. This timer is only a fallback for when no `animationend`
// fires (animations disabled mid-flight, detached node, etc.).
const exitTimers = new Map<HTMLLIElement, ReturnType<typeof setTimeout>>();

const EXIT_SAFETY_MS = 1500; // > slideOutLeft (0.28s); fallback remover only.

function removeExitNode(li: HTMLLIElement): void {
  const t = exitTimers.get(li);
  if (t !== undefined) { clearTimeout(t); exitTimers.delete(li); }
  if (li.parentElement) li.remove();
}

// Pin a row at its current geometry and take it out of layout flow. Its
// siblings immediately reflow into the freed space (no JS), so a plain FLIP can
// then slide them up. The pinned row keeps painting on its own layer and slides
// out via the `slideOutLeft` animation without affecting anyone else's layout.
function pinOutOfFlow(li: HTMLLIElement): void {
  // Read all geometry BEFORE mutating styles (offset* are relative to the
  // positioned list container — see `.sessions-list { position: relative }`).
  const top = li.offsetTop;
  const left = li.offsetLeft;
  const width = li.offsetWidth;
  const height = li.offsetHeight;
  li.style.position = "absolute";
  li.style.boxSizing = "border-box";
  li.style.top = `${top}px`;
  li.style.left = `${left}px`;
  li.style.width = `${width}px`;
  li.style.height = `${height}px`;
  li.style.margin = "0";
}

// Start a row's exit: pin it out of flow, play the slide-out, remove on end.
// Does NOT animate the survivors — the caller owns that (reconcileList runs one
// FLIP over all moved rows; markSessionExiting runs its own survivor FLIP).
function beginExit(li: HTMLLIElement): void {
  if (li.classList.contains("row-exiting")) return;
  pinOutOfFlow(li);
  li.classList.add("row-exiting");
  const remove = () => removeExitNode(li);
  li.addEventListener("animationend", remove, { once: true });
  exitTimers.set(li, setTimeout(remove, EXIT_SAFETY_MS));
}

function updateNode(kept: HTMLLIElement, html: string): void {
  const tmp = document.createElement("ul");
  tmp.innerHTML = html;
  const fresh = tmp.firstElementChild as HTMLLIElement | null;
  if (!fresh) return;
  kept.className = fresh.className;
  kept.innerHTML = fresh.innerHTML;
  for (const attr of fresh.attributes) {
    if (attr.name !== "class") kept.setAttribute(attr.name, attr.value);
  }
}

function parseHtml(html: string): HTMLLIElement | null {
  const tmp = document.createElement("ul");
  tmp.innerHTML = html;
  return tmp.firstElementChild as HTMLLIElement | null;
}

function flipNodes(nodes: HTMLLIElement[], beforeRects: Map<string, DOMRect>): void {
  requestAnimationFrame(() => {
    // Measure pass: classify each move and find the bottom-most RISING row.
    // Only that row casts the lift shadow — otherwise every rising row drops
    // its own shadow onto the row beneath it, so a group moving up stacks a
    // pile of shadows on the bottom element. One shadow, under the whole group.
    const moves: Array<{ node: HTMLLIElement; dy: number; rising: boolean }> = [];
    let bottomRiser: HTMLLIElement | null = null;
    let bottomRiserTop = -Infinity;
    for (const node of nodes) {
      const k = keyOf(node);
      if (!beforeRects.has(k)) continue;
      const top = node.getBoundingClientRect().top;
      const dy = beforeRects.get(k)!.top - top;
      if (Math.abs(dy) < 0.5) continue;
      const rising = dy > 20;
      moves.push({ node, dy, rising });
      if (rising && top > bottomRiserTop) { bottomRiserTop = top; bottomRiser = node; }
    }

    // Invert: jump each row to its old position with no transition.
    for (const { node, dy } of moves) {
      node.style.transition = "none";
      node.style.transform = `translateY(${dy}px)`;
    }

    // Play: animate every row to its final spot next frame.
    requestAnimationFrame(() => {
      for (const { node, rising } of moves) {
        if (rising) {
          node.style.zIndex = "10";
          if (node === bottomRiser) node.style.boxShadow = "0 6px 22px rgba(0,0,0,0.55)";
          node.style.transition = "transform 0.34s cubic-bezier(0.34,1.2,0.64,1), box-shadow 0.34s";
          node.style.transform = "translateY(0) scale(1.036)";
          setTimeout(() => {
            node.style.transition = "transform 0.15s ease-out, box-shadow 0.15s";
            node.style.transform = "";
            node.style.boxShadow = "";
            node.addEventListener("transitionend", () => {
              node.style.zIndex = "";
              node.style.transition = "";
            }, { once: true });
          }, 340);
        } else {
          node.style.transition = "transform 0.3s cubic-bezier(0.34,1.2,0.64,1)";
          node.style.transform = "";
          node.addEventListener("transitionend", () => { node.style.transition = ""; }, { once: true });
        }
      }
    });
  });
}

/**
 * Immediately start the exit animation for a session row at click-time, before
 * the backend round-trip fires instances-changed. Pins the row out of flow and
 * slides the survivors up right away (more responsive than waiting for the
 * reconcile). The follow-up reconcile finds the survivors already at their
 * final positions, so its own FLIP no-ops them.
 */
export function markSessionExiting(listEl: HTMLElement, sessionId: string): void {
  const key = `s:${sessionId}`;
  if (exitingKeys.has(key)) return;
  const li = listEl.querySelector<HTMLLIElement>(`li[data-session-id="${CSS.escape(sessionId)}"]`);
  if (!li || li.classList.contains("row-exiting")) return;
  exitingKeys.add(key);
  // exitingKeys is cleared by reconcileList once the session is absent from
  // entries — not here — to prevent a still-live session from re-entering.

  // Snapshot the in-flow survivors BEFORE the pin reflows them up.
  const survivors = [...listEl.querySelectorAll<HTMLLIElement>("li:not(.row-exiting)")]
    .filter((n) => n !== li);
  const before = new Map<string, DOMRect>();
  for (const n of survivors) {
    const k = keyOf(n);
    if (k) before.set(k, n.getBoundingClientRect());
  }

  beginExit(li);
  flipNodes(survivors, before);
}

export function reconcileList(
  listEl: HTMLElement,
  entries: Array<{ key: string; html: string }>,
  animEnabled: boolean,
): void {
  // Once a session is fully absent from entries the backend has confirmed it's
  // gone — safe to stop suppressing it. While it's still in entries (state
  // changes before the session is truly ended) keep it suppressed so it never
  // re-enters visibleEntries and triggers an enter animation.
  const allKeys = new Set(entries.map(e => e.key));
  for (const k of exitingKeys) {
    if (!allKeys.has(k)) exitingKeys.delete(k);
  }

  // Strip rows we've already committed to animating out
  const visibleEntries = entries.filter(e => !exitingKeys.has(e.key));

  if (!animEnabled) {
    for (const li of listEl.querySelectorAll<HTMLLIElement>("li.row-exiting")) removeExitNode(li);
    listEl.innerHTML = visibleEntries.map(e => e.html).join("");
    return;
  }

  // Current live nodes (not animating out)
  const existing = new Map<string, HTMLLIElement>();
  for (const li of listEl.querySelectorAll<HTMLLIElement>("li:not(.row-exiting)")) {
    const k = keyOf(li);
    if (k) existing.set(k, li);
  }

  const newKeys = new Set(visibleEntries.map(e => e.key));

  // Snapshot positions of rows that will REMAIN before any DOM change.
  const beforeRects = new Map<string, DOMRect>();
  for (const [k, li] of existing) {
    if (newKeys.has(k)) beforeRects.set(k, li.getBoundingClientRect());
  }

  // Start exit animations for rows dropped from the list this call. Each pins
  // itself out of flow, so the survivors reflow up immediately and the single
  // FLIP below animates the move — no deferral, no removal-ordering games.
  for (const [k, li] of existing) {
    if (!newKeys.has(k)) {
      exitingKeys.add(k);
      beginExit(li);
    }
  }

  // Build ordered node list for the new state
  const nodes: HTMLLIElement[] = [];
  const enterKeys = new Set<string>();
  for (const entry of visibleEntries) {
    const kept = existing.get(entry.key);
    if (kept) {
      updateNode(kept, entry.html);
      nodes.push(kept);
    } else {
      const newLi = parseHtml(entry.html);
      if (newLi) { enterKeys.add(entry.key); nodes.push(newLi); }
    }
  }

  // Reorder + insert synchronously. appendChild on an already-in-DOM node moves
  // it to the end, so iterating the new order produces the correct sequence.
  // Exiting rows are position:absolute (out of flow), so they neither occupy a
  // slot nor get disturbed by this reordering.
  for (const node of nodes) listEl.appendChild(node);

  // Enter animations for new rows
  for (const node of nodes) {
    if (enterKeys.has(keyOf(node))) {
      node.classList.add("row-entering");
      node.addEventListener("animationend", () => node.classList.remove("row-entering"), { once: true });
    }
  }

  // FLIP the surviving rows from their snapshotted positions to their new ones.
  // Rows that markSessionExiting already settled this frame measure dy<0.5 and
  // no-op, so a click-then-reconcile sequence never double-animates.
  flipNodes(nodes, beforeRects);
}
