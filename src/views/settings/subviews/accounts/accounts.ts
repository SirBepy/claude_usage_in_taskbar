// Settings > Accounts. Minimal list + add/remove/logout/set-default + the
// read-only terminal identity row (multi-account milestone 01 frontend).
// Full polish (drift warnings, token expiry, richer cards) is milestone 07 -
// see docs/multi-account/01-account-identity.md and 00-overview.md.

import { html, render } from "lit-html";
import { escapeHtml } from "../../../../shared/escape-html";
import { api } from "../../../../shared/api";
import type { Account, AccountIdentity, OauthAccountInfo } from "../../../../shared/api";
import type { ProjectConfig } from "../../../../types/ipc.generated";
import { accountIconBadgeHtml } from "../../../../shared/account-chip";
import { pickProject } from "../../../sessions/project-picker";
import { openAddAccountWizard } from "./add-account-wizard";
import { askConfirm } from "../../../../shared/confirm";
import { buildIdentitySurface } from "./wizard-logic";
import "../../../../shared/account-chip.css";
import "./accounts.css";

interface LegacyGlobals {
  navigateTo(name: string): Promise<void>;
}
function g(): LegacyGlobals {
  return window as unknown as LegacyGlobals;
}

// Accounts whose reverse "projects using this account" panel is currently
// expanded. Module-scoped so it survives a refreshList() re-render.
const expandedAccounts = new Set<string>();

function accountRowHtml(account: Account, defaultAccountId: string | null, identity: AccountIdentity | null): string {
  const isDefault = account.id === defaultAccountId;
  const expanded = expandedAccounts.has(account.id);
  const surface = buildIdentitySurface(account, identity);
  const loggedInLine = surface.loggedInAsEmail
    ? `Logged in as ${surface.loggedInAsEmail} &middot; ${escapeHtml(surface.tierLabel)}`
    : `Registered as ${escapeHtml(account.email)} &middot; ${escapeHtml(surface.tierLabel)}`;
  return `
    <div class="acc-row-wrap">
      <div class="acc-row" data-id="${escapeHtml(account.id)}" style="--acc:${escapeHtml(account.colour)}">
        ${accountIconBadgeHtml(account)}
        <span class="acc-info">
          <span class="acc-label">${escapeHtml(account.label)}${isDefault ? `<span class="acc-default-badge">default</span>` : ""}</span>
          <span class="acc-sub">${loggedInLine}</span>
          <span class="acc-sub acc-sub-expiry">${escapeHtml(surface.tokenExpiryLabel)}</span>
          ${surface.warningMessage ? `<span class="acc-drift-warning"><i class="ph ph-warning"></i> ${escapeHtml(surface.warningMessage)}</span>` : ""}
        </span>
        <span class="acc-actions">
          ${!isDefault ? `<button class="btn-secondary acc-btn-default" data-id="${escapeHtml(account.id)}" title="Set as default account"><i class="ph ph-star"></i></button>` : ""}
          <button class="icon-btn acc-btn-reauth" data-id="${escapeHtml(account.id)}" title="Re-auth: run /login again for this account"><i class="ph ph-arrow-clockwise"></i></button>
          ${!surface.hasCookie ? `<button class="btn-secondary acc-btn-add-cookie" data-id="${escapeHtml(account.id)}" title="Connect usage tracking (browser login)"><i class="ph ph-link"></i> Connect usage</button>` : ""}
          <button class="btn-secondary acc-btn-logout" data-id="${escapeHtml(account.id)}" title="Log out (keeps the profile, stops the cookie)">Log out</button>
          <button class="acc-btn-remove" data-id="${escapeHtml(account.id)}" title="Remove account">Remove</button>
          <button class="icon-btn acc-btn-expand" data-id="${escapeHtml(account.id)}" title="Projects using this account">
            <i class="ph ph-caret-${expanded ? "up" : "down"}"></i>
          </button>
        </span>
      </div>
      <div class="acc-projects" data-id="${escapeHtml(account.id)}"${expanded ? "" : " hidden"}></div>
    </div>
  `;
}

function projectRowHtml(p: ProjectConfig): string {
  return `
    <div class="acc-project-item" data-id="${escapeHtml(p.id)}">
      <i class="ph ph-folder f"></i>
      <span class="p">${escapeHtml(p.path)}</span>
      <i class="ph ph-x x" data-id="${escapeHtml(p.id)}" title="Stop using this account for this project"></i>
    </div>
  `;
}

/** Populates one account's reverse "projects using this account" panel. */
async function refreshAccountProjects(root: HTMLElement, accountId: string): Promise<void> {
  const panel = root.querySelector<HTMLElement>(`.acc-projects[data-id="${CSS.escape(accountId)}"]`);
  if (!panel) return;
  let projects: ProjectConfig[] = [];
  try {
    projects = (await api.listProjects()) as unknown as ProjectConfig[];
  } catch (e) {
    console.error("[settings-accounts] listProjects failed", e);
  }
  const bound = projects.filter((p) => p.preferred_account_id === accountId);
  panel.innerHTML = `
    <div class="acc-project-list">
      ${bound.length === 0 ? `<p class="acc-empty">No projects bound to this account yet.</p>` : bound.map(projectRowHtml).join("")}
    </div>
    <div class="acc-project-add">
      <button class="btn-secondary acc-btn-add-project" data-id="${escapeHtml(accountId)}"><i class="ph ph-plus"></i> Add a project</button>
    </div>
  `;
  panel.querySelectorAll<HTMLElement>(".acc-project-item .x").forEach((btn) => {
    btn.addEventListener("click", () => {
      const projectId = btn.dataset.id;
      if (!projectId) return;
      void (async () => {
        try {
          await api.updateProject(projectId, { preferred_account_id: null });
          await refreshAccountProjects(root, accountId);
        } catch (e) { console.error("[settings-accounts] remove binding failed", e); }
      })();
    });
  });
  const addBtn = panel.querySelector<HTMLButtonElement>(".acc-btn-add-project");
  if (addBtn) {
    addBtn.onclick = () => {
      void (async () => {
        const picked = await pickProject();
        if (!picked) return;
        try {
          const proj = await api.ensureProject(picked.path);
          await api.updateProject(proj.id, { preferred_account_id: accountId });
          await refreshAccountProjects(root, accountId);
        } catch (e) { console.error("[settings-accounts] bind project failed", e); }
      })();
    };
  }
}

async function refreshList(root: HTMLElement): Promise<void> {
  const list = root.querySelector<HTMLElement>("#acc-list");
  const empty = root.querySelector<HTMLElement>("#acc-empty");
  if (!list) return;

  let accounts: Account[] = [];
  let defaultAccountId: string | null = null;
  let identities: Record<string, AccountIdentity | null> = {};
  try {
    accounts = await api.listAccounts();
    const settings = await api.getSettings();
    defaultAccountId = (settings?.["default_account_id"] as string | null | undefined) ?? null;
    const fetched = await Promise.all(accounts.map((a) => api.getAccountIdentity(a.id)));
    identities = Object.fromEntries(accounts.map((a, i) => [a.id, fetched[i] ?? null]));
  } catch (e) {
    console.error("[settings-accounts] refreshList failed", e);
  }

  if (empty) empty.style.display = accounts.length === 0 ? "" : "none";
  list.innerHTML = accounts.map((a) => accountRowHtml(a, defaultAccountId, identities[a.id] ?? null)).join("");

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

  list.querySelectorAll<HTMLButtonElement>(".acc-btn-reauth").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      if (!id) return;
      void (async () => {
        btn.disabled = true;
        try {
          await api.reauthAccount(id);
          alert("A terminal opened for /login. Run it, then reopen this screen to see the refreshed identity.");
        } catch (e) {
          console.error("[settings-accounts] reauthAccount failed", e);
        } finally {
          btn.disabled = false;
        }
      })();
    });
  });

  list.querySelectorAll<HTMLButtonElement>(".acc-btn-add-cookie").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      if (!id) return;
      void (async () => {
        btn.disabled = true;
        try { await api.recaptureAccountCookie(id); await refreshList(root); }
        catch (e) {
          console.error("[settings-accounts] recaptureAccountCookie failed", e);
          alert(e instanceof Error ? e.message : "Connecting usage tracking failed - see the console.");
        } finally {
          btn.disabled = false;
        }
      })();
    });
  });

  list.querySelectorAll<HTMLButtonElement>(".acc-btn-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      if (!id) return;
      const row = accounts.find((a) => a.id === id);
      const label = row?.label ?? "this account";
      void (async () => {
        if (!(await askConfirm(`Remove ${label}? This deletes its profile folder (and its browser/cookie login) - it never touches ~/.claude.`))) return;
        btn.disabled = true;
        try { await api.removeAccount(id); await refreshList(root); }
        catch (e) {
          console.error("[settings-accounts] removeAccount failed", e);
          alert(e instanceof Error ? e.message : "Removing the account failed - see the console.");
          btn.disabled = false;
        }
      })();
    });
  });

  list.querySelectorAll<HTMLButtonElement>(".acc-btn-expand").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      if (!id) return;
      if (expandedAccounts.has(id)) expandedAccounts.delete(id);
      else expandedAccounts.add(id);
      void refreshList(root);
    });
  });

  // Re-populate any panels the user already had open before this refresh.
  for (const id of expandedAccounts) {
    if (accounts.some((a) => a.id === id)) void refreshAccountProjects(root, id);
  }
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
