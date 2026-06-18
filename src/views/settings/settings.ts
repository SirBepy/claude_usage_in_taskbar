import { html, render } from "lit-html";
import { openSidemenu } from "../../shared/sidemenu";
import { saveSettings } from "../../shared/settings-save";
import { getSettings } from "../../shared/state";
import { api } from "../../shared/api";
import type { DatasetInfo, DatasetId, RetentionPolicy } from "../../types/ipc.generated";
import "./settings.css";

export { saveSettings };

interface LegacyGlobals {
  navigateTo(name: string): Promise<void>;
  renderSettingsRoot?: () => Promise<void> | void;
  saveSettings?: () => void;
}

function g(): LegacyGlobals {
  return window as unknown as LegacyGlobals;
}

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

async function hydrateSettingsRoot(): Promise<void> {
  const s = getSettings();
  const launchAtLogin = $("launchAtLogin") as HTMLInputElement | null;
  if (!launchAtLogin) return;

  launchAtLogin.checked = !!s.launchAtLogin;
  launchAtLogin.addEventListener("change", saveSettings);
}

// Back-compat window binding.
(window as unknown as { renderSettingsRoot?: () => Promise<void> }).renderSettingsRoot = hydrateSettingsRoot;

// ── Settings > Data section ────────────────────────────────────────────────

const RETENTION_OPTIONS: { value: RetentionPolicy; label: string }[] = [
  { value: "forever", label: "Never" },
  { value: "365d", label: "1 year" },
  { value: "90d", label: "90 days" },
  { value: "30d", label: "30 days" },
  { value: "7d", label: "7 days" },
];

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// "52340" -> "52,340". record_count arrives as bigint (unix-second counts can
// exceed safe-int territory only in theory, but bigint formats fine via String).
function formatCount(n: bigint): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// unix SECONDS (bigint) -> "Mon YYYY". Multiply into ms as a Number; even far-
// future second values stay well within Number's safe range.
function formatMonthYear(unixSeconds: bigint): string {
  const d = new Date(Number(unixSeconds) * 1000);
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function formatBytes(bytes: bigint): string {
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

function datasetSubline(info: DatasetInfo): string {
  if (info.record_count === BigInt(0) || info.oldest_entry === null || info.newest_entry === null) {
    return "No data yet";
  }
  const range = `${formatMonthYear(info.oldest_entry)} - ${formatMonthYear(info.newest_entry)}`;
  return `${formatCount(info.record_count)} records · ${range}`;
}

function dataCardHtml(info: DatasetInfo): string {
  const options = RETENTION_OPTIONS.map((o) => {
    const sel = o.value === info.retention ? " selected" : "";
    return `<option value="${o.value}"${sel}>${o.label}</option>`;
  }).join("");
  return `
    <div class="kit-section data-card">
      <div class="data-card-head">
        <span class="kit-row-label">${escapeHtml(info.label)}</span>
        <span class="data-card-sub">${escapeHtml(datasetSubline(info))}</span>
      </div>
      <div class="kit-row data-card-controls">
        <span class="kit-row-label data-control-label">Keep for</span>
        <div class="data-control-actions">
          <select class="data-retention" data-dataset="${info.dataset}">${options}</select>
          <button class="btn-danger data-clear" data-dataset="${info.dataset}">Clear all</button>
        </div>
      </div>
    </div>`;
}

let dataWired = false;

async function refreshDataSection(): Promise<void> {
  const cards = $("dataCards");
  const totalEl = $("dataTotal");
  if (!cards || !totalEl) return;

  const infos = await api.getStorageInfo();
  cards.innerHTML = infos.map(dataCardHtml).join("");

  // total_db_bytes is identical on every entry; read it once.
  const first = infos[0];
  if (first) {
    totalEl.textContent = `Total: ${formatBytes(first.total_db_bytes)}`;
    totalEl.style.display = "";
  } else {
    totalEl.style.display = "none";
  }

  // Delegated listeners bound once to the stable container, so re-rendering the
  // innerHTML on refresh doesn't accumulate handlers.
  if (!dataWired) {
    dataWired = true;
    cards.addEventListener("change", (e) => {
      const sel = (e.target as HTMLElement)?.closest<HTMLSelectElement>("select.data-retention");
      if (!sel) return;
      const dataset = sel.dataset.dataset as DatasetId | undefined;
      if (!dataset) return;
      const policy = sel.value as RetentionPolicy;
      void (async () => {
        try {
          await api.setRetentionPolicy(dataset, policy);
          await refreshDataSection();
        } catch (err) {
          console.error("[settings data] set retention failed", err);
        }
      })();
    });
    cards.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement)?.closest<HTMLButtonElement>("button.data-clear");
      if (!btn) return;
      const dataset = btn.dataset.dataset as DatasetId | undefined;
      if (!dataset) return;
      void (async () => {
        try {
          await api.clearDataset(dataset);
          await refreshDataSection();
        } catch (err) {
          console.error("[settings data] clear dataset failed", err);
        }
      })();
    });
  }
}

export async function renderSettingsView(
  root: HTMLElement,
): Promise<() => void> {
  render(template(), root);

  const burger = root.querySelector<HTMLButtonElement>("#burgerBtn-settings");
  if (burger) burger.onclick = () => openSidemenu();

  const navVisuals = root.querySelector<HTMLElement>("#nav-visuals");
  const navThemes = root.querySelector<HTMLElement>("#nav-themes");
  const navSound = root.querySelector<HTMLElement>("#nav-sound");
  const navNotifs = root.querySelector<HTMLElement>("#nav-notifications");
  const navPresets = root.querySelector<HTMLElement>("#nav-presets");
  const navPermissions = root.querySelector<HTMLElement>("#nav-permissions");
  const navCharacters = root.querySelector<HTMLElement>("#nav-characters");
  const navShortcuts = root.querySelector<HTMLElement>("#nav-shortcuts");
  const navStatusline = root.querySelector<HTMLElement>("#nav-statusline");
  const navRemoteAccess = root.querySelector<HTMLElement>("#nav-remote-access");
  const navAbout = root.querySelector<HTMLElement>("#nav-about");
  if (navVisuals) navVisuals.onclick = () => g().navigateTo("settings-visuals");
  if (navThemes) navThemes.onclick = () => g().navigateTo("settings-themes");
  if (navSound) navSound.onclick = () => g().navigateTo("settings-sound");
  if (navNotifs) navNotifs.onclick = () => g().navigateTo("settings-notifications");
  if (navPresets) navPresets.onclick = () => g().navigateTo("settings-presets");
  if (navPermissions) navPermissions.onclick = () => g().navigateTo("settings-permissions");
  if (navCharacters) navCharacters.onclick = () => g().navigateTo("settings-characters");
  if (navShortcuts) navShortcuts.onclick = () => g().navigateTo("settings-shortcuts");
  if (navStatusline) navStatusline.onclick = () => g().navigateTo("settings-statusline");
  if (navRemoteAccess) navRemoteAccess.onclick = () => g().navigateTo("settings-remote-access");
  if (navAbout) navAbout.onclick = () => g().navigateTo("settings-about");

  const logoutBtn = root.querySelector<HTMLButtonElement>("#logoutBtn");
  if (logoutBtn) logoutBtn.onclick = () => { void api.logout(); };

  try { await hydrateSettingsRoot(); }
  catch (e) { console.error("[settings root] render failed", e); }

  // Fresh container each render -> rebind the delegated Data listeners.
  dataWired = false;
  try { await refreshDataSection(); }
  catch (e) { console.error("[settings data] render failed", e); }

  return () => {};
}

function template() {
  return html`
    <div class="view view-settings">
      <div class="view-header">
        <button class="icon-btn burger" id="burgerBtn-settings" title="Menu" data-burger="true">
          <i class="ph ph-list"></i>
        </button>
        <h2>Settings</h2>
        <div style="width:32px"></div>
      </div>
      <div class="view-body">

        <div class="kit-section">
          <div class="kit-section-title">Appearance</div>
          <div class="kit-row kit-nav-row" id="nav-visuals">
            <span class="kit-row-label">Visuals</span>
            <span class="kit-nav-arrow">›</span>
          </div>
          <div class="kit-row kit-nav-row" id="nav-themes">
            <span class="kit-row-label">Themes</span>
            <span class="kit-nav-arrow">›</span>
          </div>
        </div>

        <div class="kit-section">
          <div class="kit-section-title">Agent</div>
          <div class="kit-row kit-nav-row" id="nav-presets">
            <span class="kit-row-label">Session presets</span>
            <span class="kit-nav-arrow">›</span>
          </div>
          <div class="kit-row kit-nav-row" id="nav-permissions">
            <span class="kit-row-label">Permissions</span>
            <span class="kit-nav-arrow">›</span>
          </div>
          <div class="kit-row kit-nav-row" id="nav-characters">
            <span class="kit-row-label">Characters</span>
            <span class="kit-nav-arrow">›</span>
          </div>
          <div class="kit-row kit-nav-row" id="nav-statusline">
            <span class="kit-row-label">Statusline</span>
            <span class="kit-nav-arrow">›</span>
          </div>
        </div>

        <div class="kit-section">
          <div class="kit-section-title">System</div>
          <div class="kit-row kit-nav-row" id="nav-sound">
            <span class="kit-row-label">Sound</span>
            <span class="kit-nav-arrow">›</span>
          </div>
          <div class="kit-row kit-nav-row" id="nav-notifications">
            <span class="kit-row-label">Notifications</span>
            <span class="kit-nav-arrow">›</span>
          </div>
          <div class="kit-row kit-nav-row" id="nav-shortcuts">
            <span class="kit-row-label">Shortcuts</span>
            <span class="kit-nav-arrow">›</span>
          </div>
          <div class="kit-row kit-nav-row" id="nav-remote-access">
            <span class="kit-row-label"><i class="ph ph-device-mobile"></i> Remote access</span>
            <span class="kit-nav-arrow">›</span>
          </div>
          <div class="kit-row">
            <span class="kit-row-label">Launch at Login</span>
            <label class="kit-toggle">
              <input type="checkbox" id="launchAtLogin">
              <span class="kit-toggle-track"></span>
            </label>
          </div>
        </div>

        <div class="kit-section">
          <div class="kit-row kit-nav-row" id="nav-about">
            <span class="kit-row-label">About & Updates</span>
            <span class="kit-nav-arrow">›</span>
          </div>
        </div>

        <div class="kit-section" id="dataSection">
          <div class="kit-section-title">Data</div>
          <!-- Cards injected as a plain innerHTML string (NOT a lit .map):
               production lit-html silently drops repeated/nested templates
               containing a <select>. See project memory. -->
          <div id="dataCards" class="data-cards"></div>
          <div id="dataTotal" class="data-total"></div>
        </div>

        <div class="kit-section" style="border-color: rgba(224,82,82,0.3);">
          <div class="kit-section-title" style="color: var(--danger);">Account</div>
          <button class="btn-danger" id="logoutBtn">Log Out</button>
        </div>

      </div>
    </div>
  `;
}
