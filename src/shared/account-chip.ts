// Shared account icon/colour rendering (multi-account milestone 04). One
// definition reused by Settings > Accounts, the project Automation "Claude
// account" row, its reverse "projects using this account" list, and the
// new-chat account picker - never a per-view visual copy.
// See docs/multi-account/04-project-binding.md.

import { escapeHtml } from "./escape-html";

export interface AccountChipInfo {
  icon: string;
  colour: string;
  label: string;
}

/** The 4-field "lite account" shape shared by the dashboard account-selector,
 * new-chat account picker, and overlay row mapping - each only needs id +
 * the display fields, not the full `Account` type from shared/api.ts. One
 * declaration here, imported everywhere, instead of three per-view copies. */
export interface AccountLite {
  id: string;
  label: string;
  icon: string;
  colour: string;
}

/** Coloured circular icon badge for an account. Pair with `.account-chip-css`
 * (imported by the caller) for the `.account-icon-badge` rule. */
export function accountIconBadgeHtml(a: AccountChipInfo): string {
  return `<span class="account-icon-badge" style="--acc:${escapeHtml(a.colour)}"><i class="ph ph-${escapeHtml(a.icon)}"></i></span>`;
}

/** Icon badge + label, inline (a "chip"). `selected` adds the `.sel` state
 * used by the new-chat picker's chip row. `extraAttrs` is a raw (already
 * escaped) attribute string, e.g. `data-acc-id="..."` for a clickable chip
 * option - callers own escaping any values they interpolate into it. */
export function accountChipHtml(a: AccountChipInfo, selected = false, extraAttrs = ""): string {
  return `<span class="account-chip${selected ? " sel" : ""}" style="--acc:${escapeHtml(a.colour)}"${extraAttrs ? ` ${extraAttrs}` : ""}>${accountIconBadgeHtml(a)}${escapeHtml(a.label)}</span>`;
}
