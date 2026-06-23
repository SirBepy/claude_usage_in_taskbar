/**
 * Hardware / browser BACK button handling for the phone PWA.
 *
 * On Android the hardware back button drives browser history. The app's hash
 * router never pushed real history entries, so pressing back walked straight
 * off the SPA's single entry and CLOSED the app. This installs a history
 * "trap": one sentinel entry is kept on the stack and re-pushed on every
 * popstate, so back can never exit. Each press is routed to handleBack(), which:
 *
 *   1. closes the top open overlay (modal, sidemenu, prompt card, mobile chat
 *      pane, news article) if any is registered, else
 *   2. steps back one entry through the view-navigation stack, else
 *   3. stays put at the root (back never closes the app).
 *
 * Overlays register a handler via registerOverlayBack(); it returns true if it
 * consumed the press. The router feeds the view stack via noteNavigation().
 *
 * Desktop (Tauri webview) has no hardware back button, so initBackButton() is
 * only called there in the remote/phone client. The module has no DOM imports
 * and no-ops cleanly when window/history are absent (node tests).
 */

/** Back handler for a transient overlay. Returns true if it consumed the press
 *  (the overlay was open and is now closed), false to fall through. */
export type OverlayBack = () => boolean;

let viewStack: string[] = [];
let suppressNote = false;
const overlays: OverlayBack[] = [];
let installed = false;

/**
 * Record a view navigation so hardware-back can step back through screens.
 * Navigating to a view already in the stack rewinds to it (so an in-screen Back
 * button doesn't leave a forward entry that hardware-back would bounce into);
 * a fresh view is pushed. The router calls this from navigateTo().
 */
export function noteNavigation(name: string): void {
  if (suppressNote) return;
  const top = viewStack[viewStack.length - 1];
  if (top === name) return;
  const existing = viewStack.lastIndexOf(name);
  if (existing >= 0) {
    viewStack.length = existing + 1;
  } else {
    viewStack.push(name);
  }
}

/**
 * Register an overlay's back handler. Handlers are consulted most-recently-
 * registered first (LIFO), so back closes the most recently opened thing.
 * Returns a disposer to call when the overlay closes by other means.
 */
export function registerOverlayBack(fn: OverlayBack): () => void {
  overlays.push(fn);
  return () => {
    const i = overlays.lastIndexOf(fn);
    if (i >= 0) overlays.splice(i, 1);
  };
}

function goBackView(): boolean {
  // At the root there is nothing to go back to: return false so back stays put
  // rather than exiting.
  if (viewStack.length <= 1) return false;
  viewStack.pop();
  const prev = viewStack[viewStack.length - 1] ?? "dashboard";
  const nav = (window as unknown as {
    navigateTo?: (n: string) => void | Promise<void>;
  }).navigateTo;
  suppressNote = true;
  try {
    void nav?.(prev);
  } finally {
    suppressNote = false;
  }
  return true;
}

/** Resolve a single back press. Exported for unit tests; production triggers it
 *  from the popstate listener installed by initBackButton(). */
export function handleBack(): void {
  for (let i = overlays.length - 1; i >= 0; i--) {
    if (overlays[i]?.()) return;
  }
  if (goBackView()) return;
  // Root reached: do nothing. Back must never close the app.
}

/**
 * Install the history trap + popstate listener. Idempotent; no-op when there is
 * no window/history (node test env). Call once, on the phone client only.
 */
export function initBackButton(): void {
  if (installed) return;
  if (typeof window === "undefined" || typeof history === "undefined") return;
  installed = true;

  // Defensive seed: the router's first navigateTo normally records the initial
  // view before this runs, but seed it if the stack is still empty.
  if (viewStack.length === 0) {
    const initial =
      (typeof location !== "undefined" && location.hash.replace(/^#/, "")) ||
      "dashboard";
    viewStack.push(initial);
  }

  // Prime the trap: one extra entry that the first back press consumes instead
  // of exiting the SPA.
  history.pushState({ __backTrap: true }, "");
  window.addEventListener("popstate", () => {
    // Re-prime so the NEXT back also fires popstate (never escapes the SPA),
    // then resolve this press.
    history.pushState({ __backTrap: true }, "");
    handleBack();
  });
}

/** Test-only: reset all module state between cases. */
export function resetBackButtonForTests(): void {
  viewStack = [];
  suppressNote = false;
  overlays.length = 0;
  installed = false;
}

/** Test-only: read the current view stack. */
export function viewStackForTests(): string[] {
  return [...viewStack];
}
