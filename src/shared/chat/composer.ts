// Composer: textarea + send button + image paste support. Phase 5b ships
// without IPC wiring (the paste handler best-effort calls `paste_image` if
// it exists, falls back to attaching base64 only). Phase 6 wires the IPC
// command and converts attachments to <file:path> mention text on send.

import { invoke } from "../ipc";
import type { ContentBlock } from "../../types/ipc.generated";

interface Attachment {
  mime: string;
  data: string; // base64 (no data: prefix)
  path: string | null; // populated by paste_image IPC; null if Phase 6 not landed
}

export interface ComposerOptions {
  onSend: (blocks: ContentBlock[]) => Promise<void> | void;
}

export class Composer {
  private root: HTMLElement;
  private opts: ComposerOptions;
  private attachments: Attachment[] = [];
  private sessionId: string | null = null;
  private disabled = false;
  private textarea: HTMLTextAreaElement | null = null;
  private attachmentsEl: HTMLElement | null = null;
  private sendBtn: HTMLButtonElement | null = null;

  constructor(root: HTMLElement, opts: ComposerOptions) {
    this.root = root;
    this.opts = opts;
    this.render();
  }

  setSessionId(id: string, opts: { readOnly?: boolean } = {}): void {
    const draftText = this.textarea?.value ?? "";
    this.sessionId = id;
    this.disabled = !!opts.readOnly;
    this.render();
    // Preserve in-progress draft across re-renders (e.g. when the user toggles
    // takeover from read-only to interactive while typing).
    if (this.textarea && draftText) this.textarea.value = draftText;
  }

  private render(): void {
    const placeholder = this.disabled
      ? "Read-only - click Take over to interact"
      : "Type a message. Shift+Enter for newline. Paste images.";
    this.root.innerHTML = `
      <div class="composer-attachments"></div>
      <div class="composer-row">
        <textarea class="composer-textarea" placeholder="${placeholder}" ${this.disabled ? "disabled" : ""}></textarea>
        <button class="composer-send icon-btn" ${this.disabled ? "disabled" : ""} title="Send">
          <i class="ph ph-paper-plane-right"></i>
        </button>
      </div>
    `;
    this.textarea = this.root.querySelector<HTMLTextAreaElement>(".composer-textarea");
    this.attachmentsEl = this.root.querySelector<HTMLElement>(".composer-attachments");
    this.sendBtn = this.root.querySelector<HTMLButtonElement>(".composer-send");

    if (!this.disabled) {
      this.textarea?.addEventListener("keydown", this.onKey.bind(this));
      this.textarea?.addEventListener("paste", this.onPaste.bind(this));
      this.sendBtn?.addEventListener("click", () => void this.send());
    }
  }

  private async onKey(e: KeyboardEvent): Promise<void> {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      await this.send();
    }
  }

  private async onPaste(e: ClipboardEvent): Promise<void> {
    if (!e.clipboardData) return;
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (!blob) continue;
        const data = await blobToBase64(blob);
        let path: string | null = null;
        if (this.sessionId) {
          try {
            path = await invoke<string>("paste_image", {
              sessionId: this.sessionId,
              base64Data: data,
              mime: blob.type,
            });
          } catch (err) {
            console.warn("[Composer] paste_image not available yet:", err);
          }
        }
        this.attachments.push({ mime: blob.type, data, path });
        this.renderAttachments();
      }
    }
  }

  private renderAttachments(): void {
    if (!this.attachmentsEl) return;
    this.attachmentsEl.innerHTML = this.attachments
      .map(
        (a, i) =>
          `<div class="attachment"><img src="data:${a.mime};base64,${a.data}" alt=""><button class="rm" data-i="${i}" title="Remove">×</button></div>`,
      )
      .join("");
    this.attachmentsEl.querySelectorAll<HTMLButtonElement>(".rm").forEach((btn) => {
      btn.addEventListener("click", () => {
        const i = Number(btn.dataset.i);
        if (Number.isFinite(i)) {
          this.attachments.splice(i, 1);
          this.renderAttachments();
        }
      });
    });
  }

  private async send(): Promise<void> {
    if (this.disabled) return;
    const text = (this.textarea?.value ?? "").trim();
    if (!text && this.attachments.length === 0) return;

    const blocks: ContentBlock[] = [];
    if (text) blocks.push({ type: "text", text });
    for (const a of this.attachments) {
      if (a.path) {
        blocks.push({ type: "text", text: `<file:${a.path}>` });
      } else {
        // Phase 6 not landed yet: paste_image IPC failed/missing. Surface
        // visibly so the user knows the image won't reach claude (instead
        // of silently dropping it).
        blocks.push({
          type: "text",
          text: "[image attachment dropped - paste_image IPC not yet available; upgrade backend or manually add the image path]",
        });
      }
    }

    if (this.textarea) this.textarea.value = "";
    this.attachments = [];
    this.renderAttachments();

    try {
      await this.opts.onSend(blocks);
    } catch (err) {
      console.error("[Composer] onSend failed", err);
    }
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
