// Add-account wizard modal (multi-account milestone 01 frontend).
// Drives the backend IPC in src-tauri/src/ipc/accounts.rs:
//   add_account_create -> poll add_account_check_login -> optional
//   add_account_capture_cookie -> add_account_finalize, with add_account_cancel
//   on any bail-out. See docs/multi-account/01-account-identity.md.

import { escapeHtml } from "../../../../shared/escape-html";
import { api } from "../../../../shared/api";
import type { Account, OauthAccountInfo } from "../../../../shared/api";
import "./add-account-wizard.css";
import {
  ICON_POOL,
  COLOUR_POOL,
  LOGIN_POLL_INTERVAL_MS,
  pickAvailableIcon,
  nextRerollIndex,
  prefillLabel,
  tierLabel,
  formatElapsed,
  isLoginTimedOut,
  describeLoginOutcome,
} from "./wizard-logic";

type Step = "create" | "login" | "cookie" | "finalize";

/**
 * Opens the add-account wizard. `existingAccounts` is used only to steer the
 * icon reroll away from icons already in use; resolves with the newly
 * created `Account` on success, or `null` if the user cancels/closes.
 */
export function openAddAccountWizard(existingAccounts: Account[]): Promise<Account | null> {
  const usedIcons = existingAccounts.map((a) => a.icon);

  return new Promise<Account | null>((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "aaw-overlay";

    let step: Step = "create";
    let busy = false;
    let error: string | null = null;

    // create step
    let nameInput = "";

    // login step
    let sessionId: string | null = null;
    let adoptedExisting = false;
    let existingIdentity: OauthAccountInfo | null = null;
    let loginSkipped = false;
    let terminalTitle: string | null = null;
    let configDir = "";
    let misdirected: string | null = null;
    let credentialsNoProfile = false;
    let manualCheckPending = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let loginStartedAt = 0;
    let elapsedMs = 0;
    let loginFailure: { kind: "mismatch" | "duplicate" | "timeout"; message: string } | null = null;

    // cookie step
    let verifiedIdentity: OauthAccountInfo | null = null;
    let cookieCaptured = false;
    let cookieError: string | null = null;

    // finalize step
    let label = "";
    let icon = "";
    let iconIndex = 0;
    let colour = COLOUR_POOL[0]!;

    function stopPolling(): void {
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }

    async function cancelSession(): Promise<void> {
      if (!sessionId) return;
      try { await api.addAccountCancel(sessionId); }
      catch (e) { console.error("[add-account-wizard] cancel failed", e); }
    }

    function close(result: Account | null): void {
      stopPolling();
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(result);
    }

    function onCancelClick(): void {
      stopPolling();
      void cancelSession().then(() => close(null));
    }

    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancelClick();
      }
    }

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) onCancelClick();
    });
    document.addEventListener("keydown", onKey);

    function stepNumber(s: Step): number {
      return { create: 1, login: 2, cookie: 3, finalize: 4 }[s];
    }

    function stepsHtml(): string {
      const order: { key: Step; label: string }[] = [
        { key: "create", label: "Create" },
        { key: "login", label: "CLI login" },
        { key: "cookie", label: "Browser login" },
        { key: "finalize", label: "Finalize" },
      ];
      const curNum = stepNumber(step);
      return order
        .map((o, i) => {
          const n = stepNumber(o.key);
          const cls = n < curNum ? "done" : n === curNum ? "cur" : "";
          const inner = n < curNum ? `<i class="ph ph-check"></i>` : String(n);
          const line = i < order.length - 1 ? `<span class="line"></span>` : "";
          return `<span class="st ${cls}"><span class="n">${inner}</span> ${escapeHtml(o.label)}</span>${line}`;
        })
        .join("");
    }

    function renderCreateStep(): string {
      return `
        <div class="field">
          <label>Account name</label>
          <input type="text" class="aaw-input" id="aaw-name" placeholder="e.g. Work" value="${escapeHtml(nameInput)}" ${busy ? "disabled" : ""}>
        </div>
        ${error ? `<div class="aaw-error"><i class="ph ph-warning-circle"></i> ${escapeHtml(error)}</div>` : ""}
        <div class="wz-actions">
          <span class="muted" style="font-size:11px">Spawns a terminal for /login</span>
          <button class="btn primary" id="aaw-create-btn" ${busy || !nameInput.trim() ? "disabled" : ""}>
            ${busy ? `<i class="ph ph-spinner aaw-spin"></i> Creating...` : "Create & log in"}
          </button>
        </div>
      `;
    }

    function renderLoginStep(): string {
      // Only meaningful when the adopted dir actually held an identity - a
      // cancelled wizard run can leave an empty husk dir behind, and telling
      // the user to "log into the SAME account" about an empty folder is
      // pure confusion.
      const adoptHint = adoptedExisting && existingIdentity && !loginSkipped
        ? `<div class="aaw-note"><i class="ph ph-info"></i> This profile dir already existed (logged in as ${escapeHtml(existingIdentity.emailAddress)}) - log into the SAME account in the terminal.</div>`
        : "";

      if (loginFailure) {
        return `
          ${adoptHint}
          <div class="aaw-error"><i class="ph ph-warning-circle"></i> ${escapeHtml(loginFailure.message)}</div>
          <div class="wz-actions">
            <span></span>
            <button class="btn" id="aaw-cancel-btn">Cancel</button>
          </div>
        `;
      }

      if (verifiedIdentity) {
        const skippedNote = loginSkipped
          ? `<div class="aaw-note"><i class="ph ph-check-circle"></i> This folder already had a valid login - no /login needed.</div>`
          : "";
        return `
          ${skippedNote}
          <div class="detected">
            <span class="av"><i class="ph ph-check-circle"></i></span>
            <span class="info">
              <div class="nm">${escapeHtml(verifiedIdentity.emailAddress)}</div>
              <div class="em">${escapeHtml(verifiedIdentity.organizationName ?? "")}${verifiedIdentity.organizationName ? " &middot; " : ""}${escapeHtml(tierLabel(verifiedIdentity.organizationType))}</div>
            </span>
            <span class="ok"><i class="ph ph-check-circle"></i> logged in</span>
          </div>
          <div class="wz-actions">
            <button class="btn" id="aaw-cancel-btn">Cancel</button>
            <button class="btn primary" id="aaw-continue-btn">Continue</button>
          </div>
        `;
      }

      const misdirectedNote = misdirected
        ? `<div class="aaw-warn"><i class="ph ph-warning"></i> <span>A login just landed in ${escapeHtml(misdirected)}, not in this account's profile. You probably used a different terminal - type /login in the window titled "${escapeHtml(terminalTitle ?? "Claude login")}".</span></div>`
        : "";
      const credentialsNoProfileNote = credentialsNoProfile
        ? `<div class="aaw-warn"><i class="ph ph-warning"></i> <span>This profile already has valid stored credentials, but Claude Code never recorded which account they belong to - and it only does that during /login itself, so waiting won't help. Use the browser login below to confirm the account instead (or run /login in the terminal if you'd rather).</span></div>`
        : "";
      const notDetectedNote = manualCheckPending && !credentialsNoProfile
        ? `<div class="aaw-warn"><i class="ph ph-warning"></i> <span>No login detected yet in <code>${escapeHtml(configDir)}</code>. Make sure /login finished in the window titled "${escapeHtml(terminalTitle ?? "Claude login")}".</span></div>`
        : "";
      return `
        ${adoptHint}
        ${misdirectedNote}
        ${credentialsNoProfileNote}
        ${notDetectedNote}
        <div class="aaw-waiting">
          <i class="ph ph-spinner aaw-spin"></i>
          <div>Run <code>/login</code> in the terminal that just opened${terminalTitle ? ` (window titled "${escapeHtml(terminalTitle)}")` : ""}, and pick the right account.</div>
          <div class="muted">Waiting... ${formatElapsed(elapsedMs)}</div>
        </div>
        <div class="wz-actions">
          <button class="btn" id="aaw-cancel-btn">Cancel</button>
          <span style="display:flex;gap:8px">
            ${credentialsNoProfile ? `<button class="btn primary" id="aaw-browser-fallback-btn">Use browser login instead</button>` : ""}
            <button class="btn" id="aaw-checknow-btn">I've logged in - check now</button>
          </span>
        </div>
      `;
    }

    function renderCookieStep(): string {
      const identity = verifiedIdentity;
      // Cookie-identity fallback (ai_todo 167): no CLI identity yet - the
      // browser login IS the identity source, so it can't be skipped.
      const header = identity
        ? `
        <div class="detected">
          <span class="av"><i class="ph ph-check-circle"></i></span>
          <span class="info">
            <div class="nm">${escapeHtml(identity.emailAddress)}</div>
            <div class="em">${escapeHtml(tierLabel(identity.organizationType))}</div>
          </span>
          <span class="ok"><i class="ph ph-check-circle"></i> CLI verified</span>
        </div>`
        : `<div class="aaw-note"><i class="ph ph-info"></i> Claude Code never confirmed which account this profile belongs to - the browser login below will confirm it instead.</div>`;
      const explain = identity
        ? `Usage tracking needs a separate browser login (claude.ai session cookie) for this
          account. This opens a browser window - log in as the SAME account.`
        : `This opens a browser window - log into claude.ai as the account this profile
          belongs to. That login identifies the account AND enables usage tracking.`;
      return `
        ${header}
        <p class="aaw-explain">${explain}</p>
        ${cookieError ? `<div class="aaw-error"><i class="ph ph-warning-circle"></i> ${escapeHtml(cookieError)}</div>` : ""}
        ${cookieCaptured ? `<div class="aaw-note"><i class="ph ph-check-circle"></i> Browser login verified${identity ? " - matches the CLI account" : ""}.</div>` : ""}
        <div class="wz-actions">
          <button class="btn" id="aaw-cancel-btn" ${busy ? "disabled" : ""}>Cancel</button>
          <span style="display:flex;gap:8px">
            ${!cookieCaptured && identity ? `<button class="btn" id="aaw-skip-btn" ${busy ? "disabled" : ""}>Skip for now</button>` : ""}
            <button class="btn primary" id="aaw-capture-btn" ${busy ? "disabled" : ""}>
              ${busy ? `<i class="ph ph-spinner aaw-spin"></i> Waiting on browser...` : cookieCaptured ? "Continue" : "Connect browser"}
            </button>
          </span>
        </div>
      `;
    }

    function renderFinalizeStep(): string {
      return `
        <div class="field" id="aaw-icon-field" style="--acc:${escapeHtml(colour)}">
          <label>Icon <span class="muted">(auto-picked, reroll if you care)</span></label>
          <div class="icon-pick">
            <div class="icon-current"><i class="ph ph-${escapeHtml(icon)}"></i></div>
            <button class="btn ghost" id="aaw-reroll-btn" type="button"><i class="ph ph-dice-five"></i> Reroll</button>
          </div>
        </div>
        <div class="field">
          <label>Account name</label>
          <input type="text" class="aaw-input" id="aaw-label" value="${escapeHtml(label)}" ${busy ? "disabled" : ""}>
        </div>
        <div class="field">
          <label>Colour</label>
          <div class="swatches">
            ${COLOUR_POOL.map((c) => `<span class="swatch${c === colour ? " sel" : ""}" data-colour="${escapeHtml(c)}" style="background:${escapeHtml(c)}"></span>`).join("")}
          </div>
        </div>
        ${error ? `<div class="aaw-error"><i class="ph ph-warning-circle"></i> ${escapeHtml(error)}</div>` : ""}
        <div class="wz-actions">
          <button class="btn" id="aaw-cancel-btn" ${busy ? "disabled" : ""}>Cancel</button>
          <button class="btn primary" id="aaw-finalize-btn" ${busy || !label.trim() ? "disabled" : ""}>
            ${busy ? `<i class="ph ph-spinner aaw-spin"></i> Adding...` : `Add ${escapeHtml(label.trim() || "account")}`}
          </button>
        </div>
      `;
    }

    function bodyHtml(): string {
      switch (step) {
        case "create": return renderCreateStep();
        case "login": return renderLoginStep();
        case "cookie": return renderCookieStep();
        case "finalize": return renderFinalizeStep();
      }
    }

    function render(): void {
      overlay.innerHTML = `
        <div class="wizard" role="dialog" aria-modal="true" aria-label="Add a Claude account">
          <div class="wz-head">
            <div class="t">Add a Claude account</div>
            <div class="wz-steps">${stepsHtml()}</div>
          </div>
          <div class="wz-body">${bodyHtml()}</div>
        </div>
      `;
      attach();
    }

    function attach(): void {
      overlay.querySelector<HTMLButtonElement>("#aaw-cancel-btn")?.addEventListener("click", onCancelClick);

      if (step === "create") {
        const nameEl = overlay.querySelector<HTMLInputElement>("#aaw-name");
        nameEl?.addEventListener("input", () => {
          nameInput = nameEl.value;
          const btn = overlay.querySelector<HTMLButtonElement>("#aaw-create-btn");
          if (btn) btn.disabled = busy || !nameInput.trim();
        });
        nameEl?.focus();
        overlay.querySelector<HTMLButtonElement>("#aaw-create-btn")?.addEventListener("click", () => void doCreate());
        nameEl?.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !busy && nameInput.trim()) void doCreate();
        });
      } else if (step === "login") {
        overlay.querySelector<HTMLButtonElement>("#aaw-continue-btn")?.addEventListener("click", () => {
          step = "cookie";
          render();
        });
        overlay.querySelector<HTMLButtonElement>("#aaw-checknow-btn")?.addEventListener("click", () => {
          manualCheckPending = true;
          void pollLogin();
        });
        overlay.querySelector<HTMLButtonElement>("#aaw-browser-fallback-btn")?.addEventListener("click", () => {
          stopPolling();
          step = "cookie";
          render();
        });
      } else if (step === "cookie") {
        overlay.querySelector<HTMLButtonElement>("#aaw-capture-btn")?.addEventListener("click", () => {
          if (cookieCaptured) { step = "finalize"; render(); return; }
          void doCaptureCookie();
        });
        overlay.querySelector<HTMLButtonElement>("#aaw-skip-btn")?.addEventListener("click", () => {
          step = "finalize";
          seedFinalizeDefaults();
          render();
        });
      } else if (step === "finalize") {
        const labelEl = overlay.querySelector<HTMLInputElement>("#aaw-label");
        labelEl?.addEventListener("input", () => {
          label = labelEl.value;
          const btn = overlay.querySelector<HTMLButtonElement>("#aaw-finalize-btn");
          if (btn) { btn.disabled = busy || !label.trim(); btn.innerHTML = `Add ${escapeHtml(label.trim() || "account")}`; }
        });
        overlay.querySelector<HTMLButtonElement>("#aaw-reroll-btn")?.addEventListener("click", () => {
          iconIndex = nextRerollIndex(ICON_POOL, iconIndex);
          icon = pickAvailableIcon(ICON_POOL, usedIcons, iconIndex);
          render();
        });
        overlay.querySelectorAll<HTMLElement>(".swatch").forEach((sw) => {
          sw.addEventListener("click", () => {
            colour = sw.dataset.colour ?? colour;
            render();
          });
        });
        overlay.querySelector<HTMLButtonElement>("#aaw-finalize-btn")?.addEventListener("click", () => void doFinalize());
      }
    }

    async function doCreate(): Promise<void> {
      busy = true;
      error = null;
      render();
      try {
        const session = await api.addAccountCreate(nameInput.trim(), null);
        sessionId = session.session_id;
        adoptedExisting = session.adopted_existing;
        existingIdentity = session.existing_identity;
        loginSkipped = session.login_skipped;
        terminalTitle = session.terminal_title;
        configDir = String(session.config_dir);
        busy = false;
        step = "login";
        startPolling();
      } catch (e) {
        busy = false;
        error = e instanceof Error ? e.message : String(e);
        render();
      }
    }

    function startPolling(): void {
      loginStartedAt = Date.now();
      elapsedMs = 0;
      loginFailure = null;
      render();
      pollTimer = setInterval(() => void pollLogin(), LOGIN_POLL_INTERVAL_MS);
      void pollLogin();
    }

    async function pollLogin(): Promise<void> {
      if (!sessionId) return;
      elapsedMs = Date.now() - loginStartedAt;
      // No timeout while the browser-login fallback is on offer
      // (credentialsNoProfile): timing out would replace the user's only
      // escape hatch with a dead-end failure card.
      if (!credentialsNoProfile && isLoginTimedOut(elapsedMs)) {
        stopPolling();
        loginFailure = { kind: "timeout", message: "Timed out waiting for /login (5 min). Cancel and try again." };
        render();
        return;
      }
      try {
        const outcome = await api.addAccountCheckLogin(sessionId);
        const view = describeLoginOutcome(outcome);
        if (view.kind === "pending") {
          misdirected = view.misdirected;
          credentialsNoProfile = view.credentialsNoProfile;
          render();
          return;
        }
        stopPolling();
        if (view.kind === "ready") {
          verifiedIdentity = view.identity;
          render();
        } else {
          loginFailure = { kind: view.kind, message: view.message };
          render();
        }
      } catch (e) {
        stopPolling();
        loginFailure = { kind: "timeout", message: e instanceof Error ? e.message : String(e) };
        render();
      }
    }

    async function doCaptureCookie(): Promise<void> {
      if (!sessionId) return;
      busy = true;
      cookieError = null;
      render();
      try {
        const derivedIdentity = await api.addAccountCaptureCookie(sessionId);
        if (derivedIdentity) verifiedIdentity = derivedIdentity;
        cookieCaptured = true;
        busy = false;
        step = "finalize";
        seedFinalizeDefaults();
        render();
      } catch (e) {
        busy = false;
        cookieError = e instanceof Error ? e.message : String(e);
        render();
      }
    }

    function seedFinalizeDefaults(): void {
      const identity = verifiedIdentity;
      if (!identity) return;
      if (!label) label = prefillLabel(identity);
      if (!icon) icon = pickAvailableIcon(ICON_POOL, usedIcons, iconIndex);
      if (!colour) colour = COLOUR_POOL[0]!;
    }

    async function doFinalize(): Promise<void> {
      if (!sessionId) return;
      busy = true;
      error = null;
      render();
      try {
        const account = await api.addAccountFinalize(sessionId, label.trim(), colour, icon);
        close(account);
      } catch (e) {
        busy = false;
        error = e instanceof Error ? e.message : String(e);
        render();
      }
    }

    document.body.appendChild(overlay);
    render();
  });
}
