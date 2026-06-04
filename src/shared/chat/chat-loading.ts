// Shared "loading transcript" overlay for chat panes. Used by both the Sessions
// view (cache-miss on opening a live session) and the History view (opening a
// past session). Pure DOM, no state — safe to import anywhere without cycles.

/**
 * Show a centered loading ring + label over `pane`, returning the overlay
 * element so the caller can `.remove()` it when the transcript has loaded.
 * Ensures `pane` is a positioning context so the overlay centers correctly.
 */
export function showChatLoadingOverlay(pane: HTMLElement): HTMLElement {
  pane.querySelector(".chat-loading-overlay")?.remove();
  if (getComputedStyle(pane).position === "static") {
    pane.style.position = "relative";
  }
  const overlay = document.createElement("div");
  overlay.className = "chat-loading-overlay";
  overlay.innerHTML = '<div class="chat-loading-ring"></div><div>Loading transcript&hellip;</div>';
  pane.appendChild(overlay);
  return overlay;
}
