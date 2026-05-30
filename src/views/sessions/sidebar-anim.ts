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

// Per-node safety-removal timers. An exiting row is normally removed by
// applyReorder (synchronously with the sibling FLIP, so the layout never
// reflows between the row's disappearance and the rows-move-up animation).
// These timers are ONLY a fallback for the rare case where no reconcile/
// applyReorder follows the exit; applyReorder clears the timer when it removes
// the node so the two paths never both fire.
const exitTimers = new Map<HTMLLIElement, ReturnType<typeof setTimeout>>();

// Version token: incremented on every reconcile call so a delayed applyReorder
// from a previous call is a no-op if a newer call superseded it.
let reorderToken = 0;

// Begin a row's slide-out. The node KEEPS occupying layout (slideOutLeft is a
// translateX, not a removal) until applyReorder takes it out. Crucially we do
// NOT remove the node on `animationend`: doing so reflows the siblings up
// before applyReorder runs its FLIP, and the FLIP — built from positions
// captured while this row still occupied space — then yanks them back down for
// one painted frame. That stale invert frame is the "flash-back". Removal is
// owned by applyReorder; the timeout below is only a no-reconcile safety net.
function beginExit(li: HTMLLIElement): void {
  if (li.classList.contains("row-exiting")) return;
  li.classList.add("row-exiting");
  exitTimers.set(li, setTimeout(() => removeExitNode(li), 1500));
}

function removeExitNode(li: HTMLLIElement): void {
  const t = exitTimers.get(li);
  if (t !== undefined) { clearTimeout(t); exitTimers.delete(li); }
  if (li.parentElement) li.remove();
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
    for (const node of nodes) {
      const k = keyOf(node);
      if (!beforeRects.has(k)) continue;
      const dy = beforeRects.get(k)!.top - node.getBoundingClientRect().top;
      if (Math.abs(dy) < 0.5) continue;

      node.style.transition = "none";
      node.style.transform = `translateY(${dy}px)`;

      const rising = dy > 20;
      requestAnimationFrame(() => {
        if (rising) {
          node.style.zIndex = "10";
          node.style.boxShadow = "0 6px 22px rgba(0,0,0,0.55)";
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
      });
    }
  });
}

/**
 * Immediately start the exit animation for a session row at click-time,
 * before the backend round-trip fires instances-changed. This ensures the
 * slide-left plays first and the row is never FLIP'd to a new sort position.
 */
export function markSessionExiting(listEl: HTMLElement, sessionId: string): void {
  const key = `s:${sessionId}`;
  if (exitingKeys.has(key)) return;
  const li = listEl.querySelector<HTMLLIElement>(`li[data-session-id="${CSS.escape(sessionId)}"]`);
  if (!li || li.classList.contains("row-exiting")) return;
  exitingKeys.add(key);
  // exitingKeys is cleared by reconcileList once the session is absent from
  // entries — not here — to prevent a still-live session from re-entering.
  beginExit(li);
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

  // Snapshot positions of rows that will REMAIN before any DOM change
  const beforeRects = new Map<string, DOMRect>();
  for (const [k, li] of existing) {
    if (newKeys.has(k)) beforeRects.set(k, li.getBoundingClientRect());
  }

  // Start exit animations for rows dropped from the list this call
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

  // Are there any exiting rows in the list right now (this call or markSessionExiting)?
  const hasExits = listEl.querySelector("li.row-exiting") !== null;

  const token = ++reorderToken;

  const applyReorder = () => {
    if (reorderToken !== token) return; // superseded by a newer reconcile call

    // Remove the exiting rows HERE — synchronously, just before the FLIP — so
    // the siblings reflow up and the FLIP plays in one step with no flash.
    for (const li of [...listEl.querySelectorAll<HTMLLIElement>("li.row-exiting")]) removeExitNode(li);

    // Reorder by appending each node in the desired order. appendChild on an
    // already-in-DOM node moves it to the end — so iterating the new order
    // produces the correct sequence with no intermediate empty-list state.
    // Skip nodes that acquired .row-exiting AFTER this reconcileList call built
    // `nodes` (i.e. a second markSessionExiting fired during the 310 ms wait).
    const liveNodes = nodes.filter(n => !n.classList.contains("row-exiting"));
    for (const node of liveNodes) listEl.appendChild(node);

    // Enter animations for new rows
    for (const node of liveNodes) {
      if (enterKeys.has(keyOf(node))) {
        node.classList.add("row-entering");
        node.addEventListener("animationend", () => node.classList.remove("row-entering"), { once: true });
      }
    }

    // FLIP remaining rows to their new positions
    flipNodes(liveNodes, beforeRects);
  };

  if (hasExits) {
    // Let the exit animation finish first, THEN move the remaining rows up
    setTimeout(applyReorder, 310);
  } else {
    applyReorder();
  }
}
