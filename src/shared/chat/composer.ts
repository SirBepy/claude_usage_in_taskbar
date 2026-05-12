// Composer: textarea + send button + image paste support. Phase 5b ships
// without IPC wiring (the paste handler best-effort calls `paste_image` if
// it exists, falls back to attaching base64 only). Phase 6 wires the IPC
// command and converts attachments to <file:path> mention text on send.

import { invoke } from "../ipc";
import type { ContentBlock } from "../../types/ipc.generated";
import { CaretSuggestPopup } from "./caret-popup/popup";
import { SlashProvider } from "./caret-popup/providers/slash";
import { FileProvider } from "./caret-popup/providers/file";
import type { SuggestProvider } from "./caret-popup/types";
import type { ChatRenderer } from "./chat-renderer";
import { parseBuiltin, HANDLERS, type BuiltinContext } from "./builtins";
import "./builtins/register";
import "./caret-popup/popup.css";

interface Attachment {
  mime: string;
  data: string; // base64 (no data: prefix)
  path: string | null; // populated by paste_image IPC; null if Phase 6 not landed
}

export interface ComposerOptions {
  onSend: (blocks: ContentBlock[]) => Promise<void> | void;
  projectDir?: string | null;
  getRenderer?: () => ChatRenderer | null;
}

let _composerInstanceCount = 0;

export class Composer {
  private root: HTMLElement;
  private opts: ComposerOptions;
  private attachments: Attachment[] = [];
  private sessionId: string | null = null;
  private disabled = false;
  private textarea: HTMLTextAreaElement | null = null;
  private attachmentsEl: HTMLElement | null = null;
  private sendBtn: HTMLButtonElement | null = null;
  private slash: SlashProvider | null = null;
  private file: FileProvider | null = null;
  private popup: CaretSuggestPopup | null = null;
  private sending = false;

  private _globalKeydown = (e: KeyboardEvent): void => {
    if (this.disabled || !this.textarea || this.textarea.disabled) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length !== 1) return;
    const active = document.activeElement;
    if (
      active instanceof HTMLTextAreaElement ||
      active instanceof HTMLInputElement ||
      active instanceof HTMLSelectElement ||
      (active instanceof HTMLElement && active.isContentEditable)
    ) return;
    this.textarea.focus();
    const start = this.textarea.selectionStart ?? this.textarea.value.length;
    const end = this.textarea.selectionEnd ?? this.textarea.value.length;
    this.textarea.value =
      this.textarea.value.slice(0, start) + e.key + this.textarea.value.slice(end);
    this.textarea.selectionStart = this.textarea.selectionEnd = start + 1;
    this.textarea.dispatchEvent(new Event("input", { bubbles: true }));
    e.preventDefault();
  };

  constructor(root: HTMLElement, opts: ComposerOptions) {
    this.root = root;
    this.opts = opts;
    // Establish positioning context so the absolute-anchored popup lands
    // above the composer instead of falling back to a distant ancestor.
    if (getComputedStyle(this.root).position === "static") {
      this.root.style.position = "relative";
    }
    this.slash = new SlashProvider();
    void this.slash.start(opts.projectDir ?? null);
    this.file = new FileProvider();
    this.file.start(opts.projectDir ?? null);
    this.render();
    document.addEventListener("keydown", this._globalKeydown);
    _composerInstanceCount++;
    if (_composerInstanceCount > 1) {
      console.warn(
        `[composer] ${_composerInstanceCount} instances alive — leak suspect`,
      );
    }
  }

  destroy(): void {
    document.removeEventListener("keydown", this._globalKeydown);
    this.popup?.destroy();
    this.popup = null;
    this.slash?.stop();
    this.slash = null;
    this.file?.stop();
    this.file = null;
    _composerInstanceCount = Math.max(0, _composerInstanceCount - 1);
  }

  setSessionId(id: string, opts: { readOnly?: boolean } = {}): void {
    const prevId = this.sessionId;
    const inMemoryDraft = this.textarea?.value ?? "";
    // Migrate any stored draft when a pending placeholder swaps to its real
    // session id, so the persisted text follows the session across the rename.
    if (prevId && prevId !== id) {
      const prevStored = loadDraft(prevId);
      if (prevStored && !loadDraft(id)) saveDraft(id, prevStored);
      clearDraft(prevId);
    }
    this.sessionId = id;
    this.disabled = !!opts.readOnly;
    this.render();
    const stored = loadDraft(id);
    const restored = inMemoryDraft || stored || "";
    if (this.textarea && restored) {
      this.textarea.value = restored;
      this.autoResize();
      if (stored && !inMemoryDraft) saveDraft(id, stored);
    }
  }

  private render(): void {
    const placeholder = this.disabled
      ? "Read-only - click Take over to interact"
      : "Type a message. Shift+Enter for newline. Paste images.";
    this.root.innerHTML = `
      <div class="composer-attachments"></div>
      <div class="composer-row">
        <textarea class="composer-textarea" rows="1" placeholder="${placeholder}" ${this.disabled ? "disabled" : ""}></textarea>
        <button class="composer-send icon-btn" ${this.disabled ? "disabled" : ""} title="Send">
          <i class="ph ph-paper-plane-right"></i>
        </button>
      </div>
    `;
    this.textarea = this.root.querySelector<HTMLTextAreaElement>(".composer-textarea");
    this.attachmentsEl = this.root.querySelector<HTMLElement>(".composer-attachments");
    this.sendBtn = this.root.querySelector<HTMLButtonElement>(".composer-send");

    // The popup div was inside root.innerHTML, so it's gone after the swap.
    // Rebuild it on every render and keep the provider's cache.
    this.popup?.destroy();
    this.popup = null;
    if (!this.disabled && this.textarea && this.slash && this.file) {
      this.popup = new CaretSuggestPopup({
        anchor: this.root,
        textarea: this.textarea,
        providers: [this.slash, this.file] as unknown as SuggestProvider<unknown>[],
      });
      this.textarea.addEventListener("keydown", this.onKey.bind(this));
      this.textarea.addEventListener("paste", this.onPaste.bind(this));
      this.textarea.addEventListener("input", () => {
        this.autoResize();
        this.popup?.handleInput();
        this.persistDraft();
      });
      this.sendBtn?.addEventListener("click", () => void this.send());
    }
    this.autoResize();
  }

  private autoResize(): void {
    const ta = this.textarea;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }

  private async onKey(e: KeyboardEvent): Promise<void> {
    if (this.popup?.handleKey(e)) return;
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
          `<div class="attachment"><img src="data:${a.mime};base64,${a.data}" alt=""><button class="rm" data-i="${i}" title="Remove"><i class="ph ph-x"></i></button></div>`,
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

  private builtinCtx(): BuiltinContext {
    return {
      sessionId: this.sessionId,
      projectDir: this.opts.projectDir ?? null,
      getRenderer: this.opts.getRenderer ?? (() => null),
      pane: this.root.closest<HTMLElement>(".session-pane") ?? this.root.parentElement,
    };
  }

  private async send(): Promise<void> {
    if (this.disabled) return;
    if (this.sending) {
      console.warn("[composer] re-entry blocked — double-fire suspect");
      return;
    }
    const text = (this.textarea?.value ?? "").trim();
    if (!text && this.attachments.length === 0) return;
    this.sending = true;

    const builtin = parseBuiltin(text);
    if (builtin) {
      const handler = HANDLERS[builtin.name];
      if (handler) {
        try {
          await handler(builtin, this.builtinCtx());
        } catch (e) {
          console.error("[builtin]", builtin.name, e);
        }
      }
      if (this.textarea) this.textarea.value = "";
      this.autoResize();
      this.attachments = [];
      this.renderAttachments();
      this.persistDraft();
      this.sending = false;
      return;
    }

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
    this.autoResize();
    this.attachments = [];
    this.renderAttachments();
    this.persistDraft();

    try {
      await this.opts.onSend(blocks);
    } catch (err) {
      console.error("[Composer] onSend failed", err);
    } finally {
      this.sending = false;
    }
  }

  private persistDraft(): void {
    if (!this.sessionId) return;
    const text = this.textarea?.value ?? "";
    if (text) saveDraft(this.sessionId, text);
    else clearDraft(this.sessionId);
  }
}

const DRAFT_PREFIX = "chat-draft:v1:";

function draftKey(sessionId: string): string {
  return DRAFT_PREFIX + sessionId;
}

function loadDraft(sessionId: string): string {
  try {
    return localStorage.getItem(draftKey(sessionId)) ?? "";
  } catch {
    return "";
  }
}

function saveDraft(sessionId: string, text: string): void {
  try {
    localStorage.setItem(draftKey(sessionId), text);
  } catch {
    /* quota or storage disabled - lose the draft, don't crash */
  }
}

function clearDraft(sessionId: string): void {
  try {
    localStorage.removeItem(draftKey(sessionId));
  } catch {
    /* ignore */
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
