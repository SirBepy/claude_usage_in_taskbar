import { html, render } from "lit-html";
import { api, type RemoteAccessStatus } from "../../../../shared/api";
import "./remote-access.css";

interface LegacyGlobals {
  navigateTo(name: string): Promise<void>;
}

function g(): LegacyGlobals {
  return window as unknown as LegacyGlobals;
}

function $(root: HTMLElement, sel: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(sel);
}

// Inject the trusted, locally-generated QR SVG string into the container, or a
// fallback message when the backend threw (Tailscale down / no token).
async function refreshQr(root: HTMLElement): Promise<void> {
  const box = $(root, "#ra-qr");
  if (!box) return;
  try {
    box.innerHTML = await api.remoteAccessQr();
  } catch {
    box.innerHTML = `<span class="ra-qr-fallback">QR unavailable - check Tailscale</span>`;
  }
}

function statusLineHtml(s: RemoteAccessStatus): string {
  if (!s.tailscale_up) {
    return `<span class="ra-status ra-status-warn"><i class="ph ph-warning"></i> Tailscale isn't connected - start/sign in to Tailscale first</span>`;
  }
  const url = s.url
    ? `<a class="ra-url" id="ra-url-link" href="#">${escapeHtml(s.url)}</a>`
    : `<span class="ra-url">(no URL yet)</span>`;
  const serve = s.serve_running
    ? `<span class="ra-status ra-status-ok"><i class="ph ph-check-circle"></i> Serving</span>`
    : `<span class="ra-status ra-status-dim"><i class="ph ph-pause-circle"></i> Not serving</span>`;
  return `${url} ${serve}`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function hydrate(root: HTMLElement): Promise<void> {
  const status = await api.remoteAccessStatus();

  // Enable toggle.
  const toggle = $(root, "#ra-enabled") as HTMLInputElement | null;
  if (toggle) {
    toggle.checked = status.enabled;
    toggle.onchange = () => {
      const next = toggle.checked;
      void (async () => {
        try {
          await api.setRemoteAccessEnabled(next);
        } catch (e) {
          console.error("[remote-access] set enabled failed", e);
        }
        await hydrate(root);
      })();
    };
  }

  // Status line.
  const statusEl = $(root, "#ra-statusline");
  if (statusEl) {
    statusEl.innerHTML = statusLineHtml(status);
    const link = statusEl.querySelector<HTMLAnchorElement>("#ra-url-link");
    if (link && status.url) {
      const url = status.url;
      link.onclick = (e) => { e.preventDefault(); void api.openExternal(url); };
    }
  }

  // QR block - only when enabled && tailscale up.
  const qrSection = $(root, "#ra-qr-section");
  const showQr = status.enabled && status.tailscale_up;
  if (qrSection) {
    qrSection.style.display = showQr ? "" : "none";
    if (showQr) await refreshQr(root);
  }
}

export async function renderRemoteAccessView(
  root: HTMLElement,
): Promise<() => void> {
  render(template(), root);

  const backBtn = root.querySelector<HTMLButtonElement>(".back-to-settings");
  if (backBtn) backBtn.onclick = () => g().navigateTo("settings");

  // Regenerate token: get the new plaintext token, show it once, re-fetch QR.
  const regenBtn = root.querySelector<HTMLButtonElement>("#ra-regen");
  if (regenBtn) {
    regenBtn.onclick = () => {
      void (async () => {
        regenBtn.disabled = true;
        try {
          const token = await api.regenerateRemoteToken();
          const tokenRow = $(root, "#ra-token-row");
          const tokenField = $(root, "#ra-token-field") as HTMLInputElement | null;
          if (tokenRow) tokenRow.style.display = "";
          if (tokenField) tokenField.value = token;
          await refreshQr(root);
        } catch (e) {
          console.error("[remote-access] regenerate token failed", e);
        } finally {
          regenBtn.disabled = false;
        }
      })();
    };
  }

  try { await hydrate(root); }
  catch (e) { console.error("[remote-access] render failed", e); }

  return () => { /* no teardown */ };
}

function template() {
  return html`
    <div class="view view-settings">
      <div class="view-header">
        <button class="icon-btn back-to-settings" title="Back">
          <i class="ph ph-arrow-left"></i>
        </button>
        <h2>Remote access</h2>
        <div style="width:32px"></div>
      </div>
      <div class="view-body">

        <div class="kit-section">
          <p class="ra-explainer">
            Control this app from your phone over your private Tailscale network.
          </p>
          <div class="kit-row">
            <span class="kit-row-label">Enable remote access</span>
            <label class="kit-toggle">
              <input type="checkbox" id="ra-enabled">
              <span class="kit-toggle-track"></span>
            </label>
          </div>
          <div class="kit-row" style="border:none">
            <span id="ra-statusline" class="ra-statusline"></span>
          </div>
        </div>

        <div class="kit-section" id="ra-qr-section" style="display:none">
          <div class="kit-section-title">Pair a device</div>
          <div id="ra-qr" class="ra-qr"></div>
          <p class="ra-caption">
            Scan with your phone's camera to open the app + sign in automatically.
          </p>
          <div class="kit-row" style="border:none">
            <button class="btn-secondary" id="ra-regen">
              <i class="ph ph-arrows-clockwise"></i> Regenerate token
            </button>
          </div>
          <div class="kit-row ra-token-row" id="ra-token-row" style="display:none;flex-direction:column;align-items:stretch;gap:6px">
            <input type="text" id="ra-token-field" class="ra-token-field" readonly>
            <span class="ra-caption">Old devices must re-pair.</span>
          </div>
        </div>

      </div>
    </div>
  `;
}
