import { escapeHtml } from "../../shared/escape-html";
import { openMoreMenu } from "./more-menu";
import { projBadgeHtml } from "./sidebar";

export interface SessionHeaderBindOpts {
  sessionId: string;
  readOnly: boolean;
  charId?: string | null;
  charUrl?: string | null;
  charStatus?: string;
  cwd?: string | null;
  autoAcceptOn?: boolean;
}

/**
 * The session pane header — avatar, title/meta, changes badge, and ⋮ menu.
 * Used by both the pending (draft) pane and the active-session pane so the
 * header is built and wired exactly once. Start in draft mode; call
 * bindSession() when the real session id is known to upgrade to the live menu.
 */
export class SessionHeader {
  readonly el: HTMLElement;

  private readonly _wrap: HTMLElement;
  private readonly _titleEl: HTMLElement;
  private readonly _metaEl: HTMLElement;
  private readonly _changesBtn: HTMLButtonElement;
  private _cancelBtn: HTMLButtonElement | null;
  private readonly _moreBtn: HTMLButtonElement;

  private _sessionId: string | null = null;
  private _readOnly = false;
  private readonly _onDiscard: (() => void) | undefined;

  onChangesClick: (() => void) | null = null;
  onCancelClick: (() => void) | null = null;
  onCharClick: (() => void) | null = null;

  constructor(opts: { title: string; meta: string; onDiscard?: () => void }) {
    this._onDiscard = opts.onDiscard;

    const el = document.createElement("header");
    el.className = "session-header";
    el.innerHTML = [
      `<span class="session-header-avatar-wrap">`,
      `  <div class="session-header-avatar">?</div>`,
      `</span>`,
      `<div class="session-header-text">`,
      `  <span class="title">${escapeHtml(opts.title)}</span>`,
      `  <span class="meta">${escapeHtml(opts.meta)}</span>`,
      `</div>`,
      `<button class="icon-btn changes-btn" title="Show all file changes in this chat" hidden>`,
      `  <i class="ph ph-git-diff"></i><span class="changes-count" hidden></span>`,
      `</button>`,
      `<button class="icon-btn cancel-btn" title="Cancel turn" hidden>`,
      `  <i class="ph ph-x"></i>`,
      `</button>`,
      `<button class="icon-btn more-btn" title="More options">`,
      `  <i class="ph ph-dots-three-vertical"></i>`,
      `</button>`,
    ].join("");

    this.el = el;
    this._wrap = el.querySelector(".session-header-avatar-wrap")!;
    this._titleEl = el.querySelector(".title")!;
    this._metaEl = el.querySelector(".meta")!;
    this._changesBtn = el.querySelector(".changes-btn")!;
    this._cancelBtn = el.querySelector(".cancel-btn");
    this._moreBtn = el.querySelector(".more-btn")!;

    this._moreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openMoreMenu(
        this._moreBtn,
        this._sessionId,
        this._readOnly,
        this._sessionId === null ? this._onDiscard : undefined,
      );
    });

    this._changesBtn.addEventListener("click", () => { this.onChangesClick?.(); });

    this._cancelBtn?.addEventListener("click", () => { void this.onCancelClick?.(); });

    // Char-click delegate on the header element so it survives avatar swaps.
    el.addEventListener("click", (e) => {
      if (!(e.target as Element).closest(".header-char-clickable")) return;
      this.onCharClick?.();
    });
  }

  setTitle(text: string): void { this._titleEl.textContent = text; }
  setMeta(text: string): void { this._metaEl.textContent = text; }

  setRemote(isRemote: boolean): void {
    const existing = this.el.querySelector(".session-header-remote-badge");
    if (isRemote && !existing) {
      const icon = document.createElement("i");
      icon.className = "ph ph-device-mobile session-header-remote-badge";
      icon.title = "Remote chat";
      this._titleEl.appendChild(icon);
    } else if (!isRemote && existing) {
      existing.remove();
    }
  }

  setChangesBadge(n: number): void {
    const badge = this._changesBtn.querySelector<HTMLElement>(".changes-count");
    if (!badge) return;
    badge.textContent = String(n);
    badge.toggleAttribute("hidden", n === 0);
  }

  setAvatar(charId: string | null, url: string | null, status: string, cwd?: string | null): void {
    const badge = projBadgeHtml(cwd ?? null, "session-header-proj-badge");
    if (charId) {
      const preload = url ? ` src="${escapeHtml(url)}" data-hydrated="${escapeHtml(charId)}"` : "";
      this._wrap.innerHTML = [
        `<span class="session-header-avatar header-char-clickable ${escapeHtml(status)}" title="Change character" role="button" tabindex="0">`,
        `  <img class="char-avatar session-header-backdrop" data-character-id="${escapeHtml(charId)}"${preload} alt="" aria-hidden="true">`,
        `  <img class="char-avatar session-header-char" data-character-id="${escapeHtml(charId)}"${preload} alt="">`,
        `</span>`,
        badge,
      ].join("");
    } else {
      this._wrap.innerHTML = [
        `<div class="session-header-avatar session-header-char-placeholder header-char-clickable ${escapeHtml(status)}" title="Change character" role="button" tabindex="0">?</div>`,
        badge,
      ].join("");
    }
  }

  /**
   * Upgrade from draft to live session. Switches the more-menu to the full
   * session menu, removes the cancel button (stop-turn lives in the menu now),
   * and unhides the changes button. Call once when the real session id is known.
   */
  bindSession(opts: SessionHeaderBindOpts): void {
    this._sessionId = opts.sessionId;
    this._readOnly = opts.readOnly;
    this._moreBtn.classList.toggle("has-indicator", !!opts.autoAcceptOn);

    this._cancelBtn?.remove();
    this._cancelBtn = null;

    this._changesBtn.removeAttribute("hidden");

    if (opts.charId !== undefined && opts.charStatus !== undefined) {
      this.setAvatar(opts.charId ?? null, opts.charUrl ?? null, opts.charStatus, opts.cwd);
    }
  }
}
