// In-app awaitable confirm. Deliberately NOT window.confirm: Tauri patches
// that to the dialog plugin's `confirm` command, which (a) returns a Promise,
// so the classic `if (!confirm(...))` guard never waits (past incident:
// account removal ran with no confirmation shown), and (b) depends on the
// window's ACL granting `dialog:allow-confirm` - a silent no-op dialog when
// it doesn't. A DOM overlay has neither failure mode and can't block the
// webview thread.
import "./confirm.css";

export interface ConfirmOptions {
  /** Confirm-button label, e.g. "Remove". Defaults to "Confirm". */
  confirmLabel?: string;
  /** Cancel-button label. Defaults to "Cancel". */
  cancelLabel?: string;
  /** Style the confirm button as destructive (red). Defaults to true. */
  danger?: boolean;
}

/** Shows an in-app modal confirm; resolves `true` only on explicit confirm.
 * Escape, the cancel button, and clicking the backdrop all resolve `false`. */
export function askConfirm(text: string, options: ConfirmOptions = {}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "app-confirm-overlay";

    const box = document.createElement("div");
    box.className = "app-confirm";
    box.setAttribute("role", "alertdialog");
    box.setAttribute("aria-modal", "true");

    const msg = document.createElement("div");
    msg.className = "app-confirm-text";
    msg.textContent = text;

    const actions = document.createElement("div");
    actions.className = "app-confirm-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "app-confirm-cancel btn-secondary";
    cancelBtn.textContent = options.cancelLabel ?? "Cancel";

    const confirmBtn = document.createElement("button");
    confirmBtn.className = `app-confirm-ok ${options.danger === false ? "btn-primary" : "btn-danger"}`;
    confirmBtn.textContent = options.confirmLabel ?? "Confirm";

    function finish(result: boolean): void {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(result);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    }

    cancelBtn.addEventListener("click", () => finish(false));
    confirmBtn.addEventListener("click", () => finish(true));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(false);
    });
    // Capture phase so an underlying modal's own Escape handler (e.g. the
    // add-account wizard) doesn't also fire while the confirm is up.
    document.addEventListener("keydown", onKey, true);

    actions.append(cancelBtn, confirmBtn);
    box.append(msg, actions);
    overlay.append(box);
    document.body.appendChild(overlay);
    cancelBtn.focus();
  });
}
