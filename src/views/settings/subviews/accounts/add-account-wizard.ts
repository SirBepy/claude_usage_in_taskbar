// Add-account wizard modal (multi-account milestone 01 frontend).
// Browser-first flow (2026-07-08): Create -> Browser login (cookie +
// identity via GET /api/account) -> CLI login only when the profile dir has
// no credentials yet (spawned on demand) -> Finalize. Drives the backend IPC
// in src-tauri/src/ipc/accounts.rs: add_account_create ->
// add_account_capture_cookie -> optional add_account_start_cli_login + poll
// add_account_check_login -> add_account_finalize, with add_account_cancel on
// any bail-out. See docs/multi-account/01-account-identity.md.

import { escapeHtml } from "../../../../shared/escape-html";
import { api } from "../../../../shared/api";
import type { Account, OauthAccountInfo } from "../../../../shared/api";
import { askConfirm } from "../../../../shared/confirm";
import "./add-account-wizard.css";
import {
  ICON_POOL,
  COLOUR_POOL,
  LOGIN_POLL_INTERVAL_MS,
  pickAvailableIcon,
  prefillLabel,
  tierLabel,
  formatElapsed,
  isLoginTimedOut,
  describeLoginOutcome,
} from "./wizard-logic";

type Step = "create" | "cookie" | "login" | "finalize";

/**
 * Opens the add-account wizard. `existingAccounts` is used only to steer the
 * icon auto-pick away from icons already in use; resolves with the newly
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

    // session
    let sessionId: string | null = null;
    let adoptedExisting = false;
    let existingIdentity: OauthAccountInfo | null = null;
    let hasCredentials = false;
    let configDir = "";

    // cookie (browser login) step
    let verifiedIdentity: OauthAccountInfo | null = null;
    let cookieCaptured = false;
    let cookieError: string | null = null;
    let browserSkipped = false;

    // CLI login step
    let terminalTitle: string | null = null;
    let misdirected: string | null = null;
    let credentialsNoProfile = false;
    let manualCheckPending = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let loginStartedAt = 0;
    let elapsedMs = 0;
    let loginFailure: { kind: "mismatch" | "duplicate" | "timeout"; message: string } | null = null;

    // finalize step
    let label = "";
    let icon = "";
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

    /** Close via X / Escape. Past step 1 there is real progress (a profile
     * dir, possibly a login) - confirm before discarding it. */
    function requestClose(): void {
      void (async () => {
        if (step !== "create") {
          const ok = await askConfirm(
            "Discard this account setup?\nProgress so far (logins included) will be thrown away.",
            { confirmLabel: "Discard", cancelLabel: "Keep going" },
          );
          if (!ok) return;
        }
        stopPolling();
        void cancelSession().then(() => close(null));
      })();
    }

    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.preventDefault();
        requestClose();
      }
    }

    // Deliberately NO overlay-click dismiss: a stray click must never nuke a
    // half-done account setup. The X (and Escape) is the only way out, and it
    // confirms first past step 1.
    document.addEventListener("keydown", onKey);

    function stepNumber(s: Step): number {
      return { create: 1, cookie: 2, login: 3, finalize: 4 }[s];
    }

    function stepsHtml(): string {
      const order: { key: Step; label: string }[] = [
        { key: "create", label: "Create" },
        { key: "cookie", label: "Browser login" },
        { key: "login", label: "CLI login" },
        { key: "finalize", label: "Finalize" },
      ];
      const curNum = stepNumber(step);
      return order
        .map((o, i) => {
          const n = stepNumber(o.key);
          // The CLI step gets skipped entirely when credentials already
          // exist - render it as done once we're past it either way.
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
          <span class="muted" style="font-size:11px">Next: log into claude.ai in a browser window</span>
          <button class="btn primary" id="aaw-create-btn" ${busy || !nameInput.trim() ? "disabled" : ""}>
            ${busy ? `<i class="ph ph-spinner aaw-spin"></i> Creating...` : "Create"}
          </button>
        </div>
      `;
    }

    function renderCookieStep(): string {
      const adoptHint = adoptedExisting && existingIdentity
        ? `<div class="aaw-note"><i class="ph ph-info"></i> This profile folder already existed (logged in as ${escapeHtml(existingIdentity.emailAddress)}) - log into the SAME account in the browser.</div>`
        : "";
      const identityBlock = verifiedIdentity
        ? `
        <div class="detected">
          <span class="av"><i class="ph ph-check-circle"></i></span>
          <span class="info">
            <div class="nm">${escapeHtml(verifiedIdentity.emailAddress)}</div>
            <div class="em">${escapeHtml(verifiedIdentity.organizationName ?? "")}${verifiedIdentity.organizationName ? " &middot; " : ""}${escapeHtml(tierLabel(verifiedIdentity.organizationType))}</div>
          </span>
          <span class="ok"><i class="ph ph-check-circle"></i> verified</span>
        </div>`
        : "";
      return `
        ${adoptHint}
        ${identityBlock}
        <p class="aaw-explain">
          Log into claude.ai as this account in the browser window. That single login
          identifies the account AND connects usage tracking.
        </p>
        ${cookieError ? `<div class="aaw-error"><i class="ph ph-warning-circle"></i> ${escapeHtml(cookieError)}</div>` : ""}
        ${cookieCaptured ? `<div class="aaw-note"><i class="ph ph-check-circle"></i> Browser login verified.</div>` : ""}
        <div class="wz-actions">
          <button class="btn" id="aaw-skip-browser-btn" ${busy ? "disabled" : ""}>Use terminal /login instead</button>
          <button class="btn primary" id="aaw-capture-btn" ${busy ? "disabled" : ""}>
            ${busy ? `<i class="ph ph-spinner aaw-spin"></i> Waiting on browser...` : cookieCaptured ? "Continue" : "Open browser login"}
          </button>
        </div>
      `;
    }

    function renderLoginStep(): string {
      if (loginFailure) {
        return `
          <div class="aaw-error"><i class="ph ph-warning-circle"></i> ${escapeHtml(loginFailure.message)}</div>
          <div class="wz-actions"><span></span><span></span></div>
        `;
      }

      const targetLine = verifiedIdentity
        ? `Log into <b>${escapeHtml(verifiedIdentity.emailAddress)}</b> - the same account as the browser step.`
        : `Pick the right account when the browser opens.`;
      const misdirectedNote = misdirected
        ? `<div class="aaw-warn"><i class="ph ph-warning"></i> <span>A login just landed in ${escapeHtml(misdirected)}, not in this account's profile. You probably used a different terminal - type /login in the window titled "${escapeHtml(terminalTitle ?? "Claude login")}".</span></div>`
        : "";
      const credentialsNoProfileNote = credentialsNoProfile && !verifiedIdentity
        ? `<div class="aaw-warn"><i class="ph ph-warning"></i> <span>This profile already has valid stored credentials, but Claude Code never recorded which account they belong to - and it only does that during /login itself, so waiting won't help. Go back to the browser login to confirm the account instead.</span></div>`
        : "";
      const notDetectedNote = manualCheckPending && !credentialsNoProfile
        ? `<div class="aaw-warn"><i class="ph ph-warning"></i> <span>No login detected yet in <code>${escapeHtml(configDir)}</code>. Make sure /login finished in the window titled "${escapeHtml(terminalTitle ?? "Claude login")}".</span></div>`
        : "";
      return `
        ${misdirectedNote}
        ${credentialsNoProfileNote}
        ${notDetectedNote}
        <div class="aaw-waiting">
          <i class="ph ph-spinner aaw-spin"></i>
          <div>Run <code>/login</code> in the terminal that just opened${terminalTitle ? ` (window titled "${escapeHtml(terminalTitle)}")` : ""}.</div>
          <div>${targetLine}</div>
          <div class="muted">This finishes on its own once the login lands. Waiting... ${formatElapsed(elapsedMs)}</div>
        </div>
        <div class="wz-actions">
          <button class="btn" id="aaw-back-to-browser-btn">${browserSkipped ? "Use browser login instead" : "Back to browser login"}</button>
          <button class="btn" id="aaw-checknow-btn">I've logged in - check now</button>
        </div>
      `;
    }

    function renderFinalizeStep(): string {
      const customColour = !COLOUR_POOL.includes(colour);
      const identitySummary = verifiedIdentity
        ? `
        <div class="detected">
          <span class="av"><i class="ph ph-check-circle"></i></span>
          <span class="info">
            <div class="nm">${escapeHtml(verifiedIdentity.emailAddress)}</div>
            <div class="em">${escapeHtml(tierLabel(verifiedIdentity.organizationType))}</div>
          </span>
          <span class="ok"><i class="ph ph-check-circle"></i> logged in</span>
        </div>`
        : "";
      return `
        ${identitySummary}
        <div class="field" id="aaw-icon-field" style="--acc:${escapeHtml(colour)}">
          <label>Icon</label>
          <div class="icon-grid">
            ${ICON_POOL.map((i) => `<button type="button" class="icon-tile${i === icon ? " sel" : ""}" data-icon="${escapeHtml(i)}"><i class="ph ph-${escapeHtml(i)}"></i></button>`).join("")}
          </div>
        </div>
        <div class="field">
          <label>Colour</label>
          <div class="swatches">
            ${COLOUR_POOL.map((c) => `<span class="swatch${c === colour ? " sel" : ""}" data-colour="${escapeHtml(c)}" style="background:${escapeHtml(c)}"></span>`).join("")}
            <label class="swatch custom${customColour ? " sel" : ""}" title="Custom colour" ${customColour ? `style="background:${escapeHtml(colour)}"` : ""}>
              <i class="ph ph-eyedropper"></i>
              <input type="color" id="aaw-custom-colour" value="${escapeHtml(customColour ? colour : "#8888ff")}">
            </label>
          </div>
        </div>
        ${error ? `<div class="aaw-error"><i class="ph ph-warning-circle"></i> ${escapeHtml(error)}</div>` : ""}
        <div class="wz-actions">
          <span></span>
          <button class="btn primary" id="aaw-finalize-btn" ${busy || !label.trim() ? "disabled" : ""}>
            ${busy ? `<i class="ph ph-spinner aaw-spin"></i> Adding...` : `Add ${escapeHtml(label.trim() || "account")}`}
          </button>
        </div>
      `;
    }

    function bodyHtml(): string {
      switch (step) {
        case "create": return renderCreateStep();
        case "cookie": return renderCookieStep();
        case "login": return renderLoginStep();
        case "finalize": return renderFinalizeStep();
      }
    }

    function render(): void {
      overlay.innerHTML = `
        <div class="wizard" role="dialog" aria-modal="true" aria-label="Add a Claude account">
          <div class="wz-head">
            <div class="wz-head-row">
              <div class="t">Add a Claude account</div>
              <button class="wz-close" id="aaw-close-btn" title="Close" aria-label="Close"><i class="ph ph-x"></i></button>
            </div>
            <div class="wz-steps">${stepsHtml()}</div>
          </div>
          <div class="wz-body">${bodyHtml()}</div>
        </div>
      `;
      attach();
    }

    function attach(): void {
      overlay.querySelector<HTMLButtonElement>("#aaw-close-btn")?.addEventListener("click", requestClose);

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
      } else if (step === "cookie") {
        overlay.querySelector<HTMLButtonElement>("#aaw-capture-btn")?.addEventListener("click", () => {
          if (cookieCaptured) { advanceAfterIdentity(); return; }
          void doCaptureCookie();
        });
        overlay.querySelector<HTMLButtonElement>("#aaw-skip-browser-btn")?.addEventListener("click", () => {
          browserSkipped = true;
          void gotoCliLogin();
        });
      } else if (step === "login") {
        overlay.querySelector<HTMLButtonElement>("#aaw-checknow-btn")?.addEventListener("click", () => {
          manualCheckPending = true;
          void pollLogin();
        });
        overlay.querySelector<HTMLButtonElement>("#aaw-back-to-browser-btn")?.addEventListener("click", () => {
          stopPolling();
          loginFailure = null;
          step = "cookie";
          render();
        });
      } else if (step === "finalize") {
        overlay.querySelectorAll<HTMLButtonElement>(".icon-tile").forEach((tile) => {
          tile.addEventListener("click", () => {
            icon = tile.dataset.icon ?? icon;
            render();
          });
        });
        overlay.querySelectorAll<HTMLElement>(".swatch[data-colour]").forEach((sw) => {
          sw.addEventListener("click", () => {
            colour = sw.dataset.colour ?? colour;
            render();
          });
        });
        const customEl = overlay.querySelector<HTMLInputElement>("#aaw-custom-colour");
        // "input" fires live while the native picker is open - a full render()
        // would destroy the input and close the picker, so live-preview in
        // place and only re-render on "change" (picker confirmed/closed).
        customEl?.addEventListener("input", () => {
          colour = customEl.value;
          overlay.querySelector<HTMLElement>("#aaw-icon-field")?.style.setProperty("--acc", colour);
          overlay.querySelectorAll<HTMLElement>(".swatch").forEach((sw) => sw.classList.remove("sel"));
          const custom = customEl.closest<HTMLElement>(".swatch.custom");
          if (custom) {
            custom.classList.add("sel");
            custom.style.background = colour;
          }
        });
        customEl?.addEventListener("change", () => {
          colour = customEl.value;
          render();
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
        hasCredentials = session.has_credentials;
        configDir = String(session.config_dir);
        busy = false;
        step = "cookie";
        render();
      } catch (e) {
        busy = false;
        error = e instanceof Error ? e.message : String(e);
        render();
      }
    }

    async function doCaptureCookie(): Promise<void> {
      if (!sessionId) return;
      busy = true;
      cookieError = null;
      render();
      try {
        verifiedIdentity = await api.addAccountCaptureCookie(sessionId);
        cookieCaptured = true;
        busy = false;
        advanceAfterIdentity();
      } catch (e) {
        busy = false;
        cookieError = e instanceof Error ? e.message : String(e);
        render();
      }
    }

    /** After the browser step establishes the identity: skip the CLI step
     * entirely when the profile dir already holds credentials. */
    function advanceAfterIdentity(): void {
      if (hasCredentials) {
        step = "finalize";
        seedFinalizeDefaults();
        render();
      } else {
        void gotoCliLogin();
      }
    }

    async function gotoCliLogin(): Promise<void> {
      if (!sessionId) return;
      step = "login";
      loginFailure = null;
      try {
        terminalTitle = await api.addAccountStartCliLogin(sessionId);
      } catch (e) {
        loginFailure = { kind: "timeout", message: e instanceof Error ? e.message : String(e) };
        render();
        return;
      }
      startPolling();
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
      // No timeout while a route back to the browser login is on offer
      // (credentialsNoProfile) - timing out would replace the escape hatch
      // with a dead-end failure card.
      if (!credentialsNoProfile && isLoginTimedOut(elapsedMs)) {
        stopPolling();
        loginFailure = { kind: "timeout", message: "Timed out waiting for /login (5 min). Close and try again." };
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
          step = "finalize";
          seedFinalizeDefaults();
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

    function seedFinalizeDefaults(): void {
      // The account name was already given on step 1 - no second name field
      // on finalize. prefillLabel(identity) only backstops the (unreachable
      // in practice) empty case.
      if (!label) label = nameInput.trim() || (verifiedIdentity ? prefillLabel(verifiedIdentity) : "");
      if (!icon) icon = pickAvailableIcon(ICON_POOL, usedIcons);
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
