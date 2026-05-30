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

// Keys we've already committed to exiting. Prevents a sort-order change
// that fires between close and full removal from FLIP-ing the row to the
// bottom before the exit animation plays.
const exitingKeys = new Set<string>();

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
  li.classList.add("row-exiting");
  const cleanup = () => { exitingKeys.delete(key); if (li.parentElement) li.remove(); };
  li.addEventListener("animationend", cleanup, { once: true });
  setTimeout(cleanup, 600);
}

export function reconcileList(
  listEl: HTMLElement,
  entries: Array<{ key: string; html: string }>,
  animEnabled: boolean,
): void {
  // Strip entries we're already animating out, regardless of anim toggle
  const visibleEntries = entries.filter(e => !exitingKeys.has(e.key));

  if (!animEnabled) {
    listEl.innerHTML = visibleEntries.map(e => e.html).join("");
    return;
  }

  // Current live nodes (ignore ones already animating out)
  const existing = new Map<string, HTMLLIElement>();
  for (const li of listEl.querySelectorAll<HTMLLIElement>("li:not(.row-exiting)")) {
    const k = keyOf(li);
    if (k) existing.set(k, li);
  }

  // Snapshot positions before touching the DOM
  const beforeRects = new Map<string, DOMRect>();
  for (const [k, li] of existing) beforeRects.set(k, li.getBoundingClientRect());

  const newKeys = new Set(visibleEntries.map(e => e.key));

  // Exit animation for removed rows
  for (const [k, li] of existing) {
    if (!newKeys.has(k)) {
      exitingKeys.add(k);
      li.classList.add("row-exiting");
      const cleanup = () => { exitingKeys.delete(k); if (li.parentElement) li.remove(); };
      li.addEventListener("animationend", cleanup, { once: true });
      setTimeout(cleanup, 600);
    }
  }

  // Build the ordered node list for the new state
  const nodes: HTMLLIElement[] = [];
  const enterKeys = new Set<string>();

  for (const entry of visibleEntries) {
    const kept = existing.get(entry.key);
    if (kept) {
      // Preserve DOM identity; update class + content in-place
      const tmp = document.createElement("ul");
      tmp.innerHTML = entry.html;
      const fresh = tmp.firstElementChild as HTMLLIElement | null;
      if (fresh) {
        kept.className = fresh.className;
        kept.innerHTML = fresh.innerHTML;
        for (const attr of fresh.attributes) {
          if (attr.name !== "class") kept.setAttribute(attr.name, attr.value);
        }
      }
      nodes.push(kept);
    } else {
      const tmp = document.createElement("ul");
      tmp.innerHTML = entry.html;
      const newLi = tmp.firstElementChild as HTMLLIElement | null;
      if (newLi) { enterKeys.add(entry.key); nodes.push(newLi); }
    }
  }

  // Remove all live nodes, re-insert in new order (exiting nodes stay put)
  for (const li of [...listEl.querySelectorAll<HTMLLIElement>("li:not(.row-exiting)")]) li.remove();
  const firstExiting = listEl.querySelector<HTMLLIElement>("li.row-exiting");
  for (const node of nodes) {
    firstExiting ? listEl.insertBefore(node, firstExiting) : listEl.appendChild(node);
  }

  // Enter animation for newly added rows
  for (const node of nodes) {
    if (enterKeys.has(keyOf(node))) {
      node.classList.add("row-entering");
      node.addEventListener("animationend", () => node.classList.remove("row-entering"), { once: true });
    }
  }

  // FLIP: animate kept rows from their old position to their new one
  requestAnimationFrame(() => {
    for (const node of nodes) {
      const k = keyOf(node);
      if (!beforeRects.has(k)) continue;
      const dy = beforeRects.get(k)!.top - node.getBoundingClientRect().top;
      if (Math.abs(dy) < 0.5) continue;

      // Cancel any in-flight transition so we start fresh
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
