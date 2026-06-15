/**
 * Token gate for the browser (phone) remote client.
 *
 * When the SPA is served from the daemon's remote-access server and the user
 * has not yet pasted their bearer token, every /api call 401s. This module
 * intercepts that situation at boot and renders a minimal full-screen form
 * prompting the user to enter the token. On submit the token is saved to
 * localStorage and the page reloads so the normal boot path runs with auth.
 *
 * This is a complete NO-OP inside the Tauri webview (window.__TAURI__ present).
 */

import { REMOTE_TOKEN_KEY } from "./transport";

/**
 * Ensure a remote bearer token is present in localStorage when running in a
 * plain browser (phone). Returns `true` immediately (no-op) inside the Tauri
 * webview or when a token is already stored. Returns `false` after rendering
 * the gate form; the caller should halt further boot in that case.
 */
export function ensureRemoteToken(): boolean {
  // Never gate inside the Tauri webview.
  if (typeof window !== "undefined" && window.__TAURI__) return true;

  // Check for an existing token.
  let token = "";
  try {
    token = localStorage.getItem(REMOTE_TOKEN_KEY) ?? "";
  } catch {
    // localStorage unavailable (e.g. node test env without a stub) - safe to proceed.
    return true;
  }
  if (token.trim()) return true;

  // No token found - render the gate and halt boot.
  renderTokenGate();
  return false;
}

function renderTokenGate(): void {
  // Build a minimal full-screen dark overlay. Inline styles only so this works
  // before any CSS bundle loads. The design matches the app's dark theme.
  const overlay = document.createElement("div");
  overlay.id = "rc-token-gate";
  overlay.style.cssText = [
    "position:fixed",
    "inset:0",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "background:#0f1117",
    "z-index:9999",
    "font-family:system-ui,sans-serif",
  ].join(";");

  const card = document.createElement("div");
  card.style.cssText = [
    "background:#1a1d27",
    "border:1px solid #2e3148",
    "border-radius:12px",
    "padding:32px 28px",
    "width:min(420px,90vw)",
    "box-shadow:0 8px 32px rgba(0,0,0,.6)",
    "color:#e0e1f0",
  ].join(";");

  const heading = document.createElement("h2");
  heading.textContent = "Enter access token";
  heading.style.cssText = "margin:0 0 8px;font-size:1.15rem;font-weight:600;color:#fff";

  const hint = document.createElement("p");
  hint.textContent =
    "Paste the token from remote-access-token.txt on your desktop to connect to your Claude companion.";
  hint.style.cssText = "margin:0 0 20px;font-size:.85rem;line-height:1.5;color:#8b8fa8";

  const input = document.createElement("input");
  input.type = "password";
  input.placeholder = "Paste token here";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.style.cssText = [
    "width:100%",
    "box-sizing:border-box",
    "padding:10px 12px",
    "background:#0f1117",
    "border:1px solid #2e3148",
    "border-radius:7px",
    "color:#e0e1f0",
    "font-size:.95rem",
    "outline:none",
    "margin-bottom:14px",
  ].join(";");

  const error = document.createElement("p");
  error.style.cssText =
    "margin:0 0 10px;font-size:.82rem;color:#f87171;display:none";
  error.textContent = "Token cannot be empty.";

  const btn = document.createElement("button");
  btn.textContent = "Connect";
  btn.type = "button";
  btn.style.cssText = [
    "width:100%",
    "padding:10px",
    "background:#5865f2",
    "color:#fff",
    "border:none",
    "border-radius:7px",
    "font-size:.95rem",
    "font-weight:600",
    "cursor:pointer",
  ].join(";");

  btn.addEventListener("click", () => {
    const val = input.value.trim();
    if (!val) {
      error.style.display = "block";
      return;
    }
    error.style.display = "none";
    try {
      localStorage.setItem(REMOTE_TOKEN_KEY, val);
    } catch {
      // Ignore - if storage is broken the page reload will 401 and we'll gate again.
    }
    window.location.reload();
  });

  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter") btn.click();
  });

  card.append(heading, hint, input, error, btn);
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  // Focus the input after a tick so any pending body renders don't steal it.
  setTimeout(() => input.focus(), 50);
}
