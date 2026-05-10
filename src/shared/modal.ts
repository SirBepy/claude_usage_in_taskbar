import { html, render, type TemplateResult } from "lit-html";

export interface ModalOptions {
  title: string;
  body: TemplateResult;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm?: () => void;
  onCancel?: () => void;
}

export function openModal(opts: ModalOptions): void {
  const host = ensureModalHost();
  render(modalTemplate(opts, closeModal), host);
  host.classList.add("open");
  document.addEventListener("keydown", onEsc);
}

export function closeModal(): void {
  const host = document.getElementById("modal-host");
  if (!host) return;
  host.classList.remove("open");
  render(html``, host);
  document.removeEventListener("keydown", onEsc);
}

function onEsc(e: KeyboardEvent): void {
  if (e.key === "Escape") closeModal();
}

export function ensureModalHost(): HTMLElement {
  let host = document.getElementById("modal-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "modal-host";
    document.body.appendChild(host);
  }
  return host;
}

function modalTemplate(
  { title, body, confirmLabel = "OK", cancelLabel = "Cancel", onConfirm, onCancel }: ModalOptions,
  close: () => void,
) {
  const cancel = () => {
    onCancel?.();
    close();
  };
  const confirm = () => {
    onConfirm?.();
    close();
  };
  return html`
    <div class="modal-backdrop" @click=${cancel}></div>
    <div class="modal-card" role="dialog" aria-modal="true" aria-label=${title}>
      <header class="modal-header"><h3>${title}</h3></header>
      <div class="modal-body">${body}</div>
      <footer class="modal-footer">
        <button class="btn btn-secondary" @click=${cancel}>${cancelLabel}</button>
        <button class="btn btn-primary" @click=${confirm}>${confirmLabel}</button>
      </footer>
    </div>
  `;
}
