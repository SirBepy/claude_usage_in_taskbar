// Settings > Accounts. Minimal list + add/remove/logout/set-default + the
// read-only terminal identity row (multi-account milestone 01 frontend).
// Full polish (drift warnings, token expiry, richer cards) is milestone 07 -
// see docs/multi-account/01-account-identity.md and 00-overview.md.

import { html, render } from "lit-html";
import { escapeHtml } from "../../../../shared/escape-html";
import { api } from "../../../../shared/api";
import type { Account, OauthAccountInfo } from "../../../../shared/api";
import { openAddAccountWizard } from "./add-account-wizard";
import { tierLabel } from "./wizard-logic";
import "./accounts.css";

interface LegacyGlobals {
  navigateTo(name: string): Promise<void>;
}
function g(): LegacyGlobals {
  return window as unknown as LegacyGlobals;
}

function accountRowHtml(account: Account, defaultAccountId: string | null): string {
  const isDefault = account.id === defaultAccountId;
  return `
    <div class="acc-row" data-id="${escapeHtml(account.id)}" style="--acc:${escapeHtml(account.colour)}">
      <span class="acc-icon"><i class="ph ph-${escapeHtml(account.icon)}"></i></span>
      <span class="acc-info">
        <span class="acc-label">${escapeHtml(account.label)}${isDefault ? `<span class="acc-default-badge">default</span>` : ""}</span>
        <span class="acc-sub">${escapeHtml(account.email)} &middot; ${escapeHtml(tierLabel(account.subscription_tier))}</span>
      </span>
      <span class="acc-actions">
        ${!isDefault ? `<button class="btn-secondary acc-btn-default" data-id="${escapeHtml(account.id)}" title="Set as default account"><i class="ph ph-star"></i></button>` : ""}
        <button class="btn-secondary acc-btn-logout" data-id="${escapeHtml(account.id)}" title="Log out (keeps the profile, stops the cookie)">Log out</button>
        <button class="acc-btn-remove" data-id="${escapeHtml(account.id)}" title="Remove account">Remove</button>
      </span>
    </div>
  `;
}

async function refreshList(root: HTMLElement): Promise<void> {
  const list = root.querySelector<HTMLElement>("#acc-list");
  const empty = root.querySelector<HTMLElement>("#acc-empty");
  if (!list) return;

  let accounts: Account[] = [];
  let defaultAccountId: string | null = null;
  try {
    accounts = await api.listAccounts();
    const settings = await api.getSettings();
    defaultAccountId = (settings?.["default_account_id"] as string | null | undefined) ?? null;
  } catch (e) {
    console.error("[settings-accounts] refreshList failed", e);
  }

  if (empty) empty.style.display = accounts.length === 0 ? "" : "none";
  list.innerHTML = accounts.map((a) => accountRowHtml(a, defaultAccountId)).join("");

  list.querySelectorAll<HTMLButtonElement>(".acc-btn-default").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      if (!id) return;
      void (async () => {
        btn.disabled = true;
        try { await api.setDefaultAccount(id); await refreshList(root); }
        catch (e) { console.error("[settings-accounts] setDefaultAccount failed", e); btn.disabled = false; }
      })();
    });
  });

  list.querySelectorAll<HTMLButtonElement>(".acc-btn-logout").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      if (!id) return;
      void (async () => {
        btn.disabled = true;
        try { await api.logoutAccount(id); await refreshList(root); }
        catch (e) { console.error("[settings-accounts] logoutAccount failed", e); btn.disabled = false; }
      })();
    });
  });

  list.querySelectorAll<HTMLButtonElement>(".acc-btn-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      if (!id) return;
      const row = accounts.find((a) => a.id === id);
      const label = row?.label ?? "this account";
      if (!confirm(`Remove ${label}? This deletes its profile folder (and its browser/cookie login) - it never touches ~/.claude.`)) return;
      void (async () => {
        btn.disabled = true;
        try { await api.removeAccount(id); await refreshList(root); }
        catch (e) { console.error("[settings-accounts] removeAccount failed", e); btn.disabled = false; }
      })();
    });
  });
}

async function refreshTerminalIdentity(root: HTMLElement): Promise<void> {
  const el = root.querySelector<HTMLElement>("#acc-terminal-identity");
  if (!el) return;
  let identity: OauthAccountInfo | null = null;
  try { identity = await api.getTerminalIdentity(); }
  catch (e) { console.error("[settings-accounts] getTerminalIdentity failed", e); }
  el.textContent = identity
    ? `Terminal: currently ${identity.emailAddress}`
    : "Terminal: not logged in (or identity unreadable)";
}

export async function renderAccountsSettingsView(root: HTMLElement): Promise<() => void> {
  render(template(), root);

  const backBtn = root.querySelector<HTMLButtonElement>(".back-to-settings");
  if (backBtn) backBtn.onclick = () => g().navigateTo("settings");

  const addBtn = root.querySelector<HTMLButtonElement>("#acc-add-btn");
  if (addBtn) {
    addBtn.onclick = () => {
      void (async () => {
        addBtn.disabled = true;
        try {
          const existing = await api.listAccounts();
          const created = await openAddAccountWizard(existing);
          if (created) await refreshList(root);
        } finally {
          addBtn.disabled = false;
        }
      })();
    };
  }

  try { await refreshList(root); }
  catch (e) { console.error("[settings-accounts] initial render failed", e); }
  try { await refreshTerminalIdentity(root); }
  catch (e) { console.error("[settings-accounts] terminal identity failed", e); }

  return () => { /* nothing to tear down */ };
}

function template() {
  return html`
    <div class="view view-settings-accounts">
      <div class="view-header">
        <button class="icon-btn back-to-settings" title="Back">
          <i class="ph ph-arrow-left"></i>
        </button>
        <h2>Accounts</h2>
        <div style="width:32px"></div>
      </div>
      <div class="view-body">

        <div class="kit-section">
          <div class="kit-section-title">Claude accounts</div>
          <p class="acc-explainer">
            Each account gets its own <code>/login</code> and browser cookie, isolated from every
            other account and from your terminal's <code>~/.claude</code>.
          </p>
          <div id="acc-list" class="acc-list"></div>
          <p id="acc-empty" class="acc-empty">No accounts added yet.</p>
          <button class="btn-secondary" id="acc-add-btn"><i class="ph ph-plus"></i> Add account</button>
        </div>

        <div class="kit-section">
          <div class="kit-section-title">Terminal</div>
          <p class="acc-explainer">
            Your plain terminal's <code>~/.claude</code> is never an app account - it's just
            observed here so you know who it's currently logged in as.
          </p>
          <div class="kit-row">
            <span id="acc-terminal-identity" class="acc-terminal-identity">Terminal: checking...</span>
          </div>
        </div>

      </div>
    </div>
  `;
}
