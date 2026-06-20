// Composer: textarea + send button + image paste support. Phase 5b ships
// without IPC wiring (the paste handler best-effort calls `paste_image` if
// it exists, falls back to attaching base64 only). Phase 6 wires the IPC
// command and converts attachments to <file:path> mention text on send.

import { invoke } from "../ipc";
import type { ContentBlock } from "../../types/ipc.generated";
import { mimeToIcon } from "./attachment-hydrator";
import { CaretSuggestPopup } from "./caret-popup/popup";
import { SlashProvider } from "./caret-popup/providers/slash";
import { FileProvider } from "./caret-popup/providers/file";
import type { SuggestProvider } from "./caret-popup/types";
import type { ChatRenderer } from "./chat-renderer";
import { parseBuiltin, HANDLERS, type BuiltinContext } from "./builtins";
import { highlightComposerInput } from "./chat-transforms";
import { VoiceController, type VoiceState } from "./voice/controller";
import { listMics, getSelectedMic, setSelectedMic } from "./voice/voice-devices";
import "./voice/voice.css";
import "./builtins/register";
import "./caret-popup/popup.css";
import { openLightbox } from "./lightbox";
import {
  loadDraft, saveDraft, clearDraft,
  loadAttachmentsMeta, saveAttachmentsMeta, clearAttachmentsMeta,
} from "./composer-persistence";
export { discardComposerDraft, moveComposerDraft } from "./composer-persistence";

interface Attachment {
  mime: string;
  data: string; // base64 (no data: prefix)
  path: string | null;
  filename: string; // original filename for display; derived from uuid path if absent
}

/** A large text paste held as a collapsed "log" chip instead of being dumped
 * into the textarea. In-memory only; inlined into the message text on send. */
interface PastedBlock {
  name: string;
  text: string;
}

// Paste payloads at or above this many characters become a pasted_log chip
// rather than landing as a wall of text in the textarea.
const PASTE_LOG_THRESHOLD = 2000;

export interface ComposerOptions {
  onSend: (blocks: ContentBlock[]) => Promise<void> | void;
  projectDir?: string | null;
  getRenderer?: () => ChatRenderer | null;
  /** True while the active session's turn is in flight. When busy, Enter stages
   * the message (via onStage) instead of sending it. */
  isBusy?: () => boolean;
  /** Stage the built blocks as a held message (only called while busy). */
  onStage?: (blocks: ContentBlock[]) => void;
  /** True when a held set exists for the active session. When not busy but
   * held items exist, a normal send bundles them via flushHeldWithDraft. */
  hasHeld?: () => boolean;
  /** Flush the held set together with the current draft as one message. The
   * composer clears itself after calling. */
  flushHeldWithDraft?: (draftBlocks: ContentBlock[]) => void;
  /** Fired on draft input/blur so a deferred auto-flush can retry. */
  onDraftActivity?: () => void;
}

let _composerInstanceCount = 0;

export class Composer {
  private root: HTMLElement;
  private opts: ComposerOptions;
  private attachments: Attachment[] = [];
  private pastedBlocks: PastedBlock[] = [];
  private sessionId: string | null = null;
  private disabled = false;
  private textarea: HTMLTextAreaElement | null = null;
  private highlightEl: HTMLElement | null = null;
  private attachmentsEl: HTMLElement | null = null;
  private sendBtn: HTMLButtonElement | null = null;
  private slash: SlashProvider | null = null;
  private file: FileProvider | null = null;
  private popup: CaretSuggestPopup | null = null;
  private sending = false;
  // Wall-clock of the last keystroke; feeds isComposing() so an auto-flush
  // doesn't fire out from under the user mid-type.
  private lastKeyAt = 0;
  // Voice dictation. `voiceCommitPos` is the textarea index where committed voice
  // text ends and the volatile (still-revising) tail begins; `voiceVolatileLen`
  // is that tail's current length. `voiceUsed` flags the composition for the
  // <voice-input/> sentinel on send.
  private voice: VoiceController | null = null;
  private voiceState: VoiceState = "idle";
  private voiceCommitPos = 0;
  private voiceVolatileLen = 0;
  private voiceUsed = false;
  private micBtn: HTMLButtonElement | null = null;
  private micSelect: HTMLSelectElement | null = null;

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
    // Repaint once the registry lands so already-typed /commands colorize.
    void this.slash.start(opts.projectDir ?? null).then(() => this.updateHighlight());
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
    void this.voice?.destroy();
    this.voice = null;
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
      const prevAttMeta = loadAttachmentsMeta(prevId);
      if (prevAttMeta.length && loadAttachmentsMeta(id).length === 0) {
        saveAttachmentsMeta(id, prevAttMeta);
      }
      clearAttachmentsMeta(prevId);
    }
    this.sessionId = id;
    this.disabled = !!opts.readOnly;
    this.render();
    const stored = loadDraft(id);
    const restored = inMemoryDraft || stored || "";
    if (this.textarea && restored) {
      this.textarea.value = restored;
      this.autoResize();
      this.updateHighlight();
      if (stored && !inMemoryDraft) saveDraft(id, stored);
    }
    // Refresh DOM so any in-memory attachments are visible in the rebuilt
    // .composer-attachments host, then async-rehydrate any persisted metas
    // from disk.
    this.renderAttachments();
    void this.restoreAttachments(id);
  }

  private async restoreAttachments(sid: string): Promise<void> {
    const metas = loadAttachmentsMeta(sid);
    if (metas.length === 0) return;
    const existingPaths = new Set(this.attachments.map(a => a.path).filter(Boolean));
    const restored: Attachment[] = [];
    for (const m of metas) {
      if (existingPaths.has(m.path)) continue;
      try {
        const r = await invoke<{ mime: string; base64: string }>("read_attachment", { path: m.path });
        restored.push({ mime: m.mime || r.mime, data: r.base64, path: m.path, filename: m.filename });
      } catch {
        // Backing file gone (GC'd or deleted). Drop silently.
      }
    }
    if (this.sessionId !== sid) return;
    if (restored.length === 0) {
      // All metas turned out to be dead; clean the LS entry.
      const stillHave = this.attachments.some(a => a.path && metas.find(m => m.path === a.path));
      if (!stillHave) clearAttachmentsMeta(sid);
      return;
    }
    this.attachments = [...this.attachments, ...restored];
    this.renderAttachments();
    this.persistAttachments();
  }

  private persistAttachments(): void {
    if (!this.sessionId) return;
    const metas = this.attachments
      .filter((a): a is Attachment & { path: string } => typeof a.path === "string" && a.path.length > 0)
      .map(a => ({ path: a.path, mime: a.mime, filename: a.filename }));
    if (metas.length) saveAttachmentsMeta(this.sessionId, metas);
    else clearAttachmentsMeta(this.sessionId);
  }

  private render(): void {
    const placeholder = this.disabled
      ? "Read-only - click Take over to interact"
      : "Type a message. Shift+Enter for newline. Paste images.";
    this.root.innerHTML = `
      <div class="composer-attachments"></div>
      <div class="composer-row">
        <div class="composer-input-wrap">
          <div class="composer-highlight" aria-hidden="true"></div>
          <textarea class="composer-textarea" rows="1" placeholder="${placeholder}" ${this.disabled ? "disabled" : ""}></textarea>
        </div>
        <select class="composer-mic-select" title="Microphone" style="display:none"></select>
        <button class="composer-mic icon-btn" ${this.disabled ? "disabled" : ""} title="Voice dictation (tap to start/stop)">
          <i class="ph ph-microphone"></i>
        </button>
        <button class="composer-send icon-btn" ${this.disabled ? "disabled" : ""} title="Send">
          <i class="ph ph-paper-plane-right"></i>
        </button>
      </div>
    `;
    this.textarea = this.root.querySelector<HTMLTextAreaElement>(".composer-textarea");
    this.highlightEl = this.root.querySelector<HTMLElement>(".composer-highlight");
    this.attachmentsEl = this.root.querySelector<HTMLElement>(".composer-attachments");
    this.sendBtn = this.root.querySelector<HTMLButtonElement>(".composer-send");
    this.micBtn = this.root.querySelector<HTMLButtonElement>(".composer-mic");
    this.micSelect = this.root.querySelector<HTMLSelectElement>(".composer-mic-select");

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
        this.lastKeyAt = Date.now();
        this.autoResize();
        this.updateHighlight();
        this.popup?.handleInput();
        this.persistDraft();
        this.opts.onDraftActivity?.();
      });
      this.textarea.addEventListener("blur", () => this.opts.onDraftActivity?.());
      this.textarea.addEventListener("scroll", () => {
        if (this.highlightEl && this.textarea) this.highlightEl.scrollTop = this.textarea.scrollTop;
      });
      this.sendBtn?.addEventListener("click", () => void this.send());
      this.micBtn?.addEventListener("click", () => void this.toggleVoice());
      this.applyVoiceButtonState();
      void this.populateMicSelect();
      this.root.classList.add("composer-root");
      this.root.addEventListener("dragover", this.onDragOver);
      this.root.addEventListener("dragleave", this.onDragLeave);
      this.root.addEventListener("drop", this.onDrop);
    }
    this.autoResize();
    this.updateHighlight();
  }

  private autoResize(): void {
    const ta = this.textarea;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }

  // Repaint the highlight backdrop (colors known /slash commands) behind the
  // transparent-text textarea, and keep it scroll-aligned.
  private updateHighlight(): void {
    if (!this.highlightEl || !this.textarea) return;
    const val = this.textarea.value;
    // While recording, paint the volatile (still-revising) voice tail faintly so
    // it reads as "live, not yet committed". Committed voice text renders normally.
    if (this.voiceState === "recording" && this.voiceVolatileLen > 0) {
      const a = val.slice(0, this.voiceCommitPos);
      const vol = val.slice(this.voiceCommitPos, this.voiceCommitPos + this.voiceVolatileLen);
      const b = val.slice(this.voiceCommitPos + this.voiceVolatileLen);
      this.highlightEl.innerHTML =
        highlightComposerInput(a) +
        `<span class="voice-volatile">${highlightComposerInput(vol)}</span>` +
        highlightComposerInput(b);
    } else {
      this.highlightEl.innerHTML = highlightComposerInput(val);
    }
    this.highlightEl.scrollTop = this.textarea.scrollTop;
  }

  // ── Voice dictation ─────────────────────────────────────────────────────────

  private async toggleVoice(): Promise<void> {
    if (this.disabled) return;
    if (!this.voice) {
      this.voice = new VoiceController({
        onPartial: (t) => this.onVoicePartial(t),
        onFinal: (t) => this.onVoiceFinal(t),
        onError: (m) => this.onVoiceError(m),
        onStateChange: (s) => this.onVoiceStateChange(s),
      });
    }
    if (this.voice.isRecording) {
      await this.voice.stop();
      return;
    }
    // Anchor voice insertion at the current caret; new words land here.
    this.textarea?.focus();
    const pos = this.textarea?.selectionStart ?? this.textarea?.value.length ?? 0;
    this.voiceCommitPos = pos;
    this.voiceVolatileLen = 0;
    await this.voice.start();
  }

  private applyVoiceButtonState(): void {
    if (!this.micBtn) return;
    this.micBtn.classList.toggle("recording", this.voiceState === "recording");
    this.micBtn.classList.toggle("connecting", this.voiceState === "connecting");
  }

  // Populate the mic-source dropdown. Hidden unless 2+ input devices exist.
  // Labels are blank until mic permission is granted once, so this is re-run
  // after the first successful recording to upgrade "Microphone N" to real names.
  private async populateMicSelect(): Promise<void> {
    const sel = this.micSelect;
    if (!sel) return;
    const mics = await listMics();
    if (mics.length < 2) {
      sel.style.display = "none";
      return;
    }
    const stored = getSelectedMic();
    sel.innerHTML = "";
    for (const m of mics) {
      const opt = document.createElement("option");
      opt.value = m.deviceId;
      opt.textContent = m.label;
      sel.appendChild(opt);
    }
    if (stored && mics.some((m) => m.deviceId === stored)) sel.value = stored;
    sel.style.display = "";
    sel.onchange = () => setSelectedMic(sel.value || null);
  }

  private onVoiceStateChange(s: VoiceState): void {
    this.voiceState = s;
    // First successful capture grants mic permission, which reveals device
    // labels - refresh the dropdown so it shows real names instead of generic.
    if (s === "recording") void this.populateMicSelect();
    if (s === "idle" || s === "error") {
      // Drop any residual volatile tail that was never finalized.
      if (this.voiceVolatileLen > 0 && this.textarea) {
        const v = this.textarea.value;
        this.textarea.value =
          v.slice(0, this.voiceCommitPos) + v.slice(this.voiceCommitPos + this.voiceVolatileLen);
        this.voiceVolatileLen = 0;
        this.autoResize();
        this.persistDraft();
      }
    }
    this.applyVoiceButtonState();
    this.updateHighlight();
  }

  private onVoicePartial(text: string): void {
    if (!this.textarea) return;
    const v = this.textarea.value;
    this.textarea.value =
      v.slice(0, this.voiceCommitPos) + text + v.slice(this.voiceCommitPos + this.voiceVolatileLen);
    this.voiceVolatileLen = text.length;
    const caret = this.voiceCommitPos + this.voiceVolatileLen;
    this.textarea.selectionStart = this.textarea.selectionEnd = caret;
    this.voiceUsed = true;
    this.afterVoiceEdit();
  }

  private onVoiceFinal(text: string): void {
    if (!this.textarea || !text) return;
    // Commit text BEFORE the volatile tail; it becomes permanent, editable text.
    const v = this.textarea.value;
    this.textarea.value = v.slice(0, this.voiceCommitPos) + text + v.slice(this.voiceCommitPos);
    this.voiceCommitPos += text.length;
    const caret = this.voiceCommitPos + this.voiceVolatileLen;
    this.textarea.selectionStart = this.textarea.selectionEnd = caret;
    this.voiceUsed = true;
    this.afterVoiceEdit();
  }

  private onVoiceError(message: string): void {
    console.warn("[voice]", message);
    if (this.micBtn) this.micBtn.title = `Voice error: ${message}`;
  }

  private afterVoiceEdit(): void {
    this.autoResize();
    this.updateHighlight();
    this.persistDraft();
    this.opts.onDraftActivity?.();
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
    let handledFile = false;
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.kind !== "file") continue;
      const blob = item.getAsFile();
      if (!blob) continue;
      e.preventDefault();
      handledFile = true;
      await this.attachBlob(blob, blob.name || `paste.${item.type.split("/")[1] ?? "bin"}`);
    }
    if (handledFile) return;
    // A big plain-text paste becomes a collapsed log chip instead of a wall of
    // text in the textarea. Claude still receives the full text inline on send.
    const text = e.clipboardData.getData("text/plain");
    if (text && text.length >= PASTE_LOG_THRESHOLD) {
      e.preventDefault();
      this.addPastedBlock(text);
    }
  }

  private addPastedBlock(text: string): void {
    const n = this.pastedBlocks.length;
    const name = n === 0 ? "pasted_log.txt" : `pasted_log_${n + 1}.txt`;
    this.pastedBlocks.push({ name, text });
    this.renderAttachments();
  }

  private async attachBlob(blob: Blob, filename: string): Promise<void> {
    const data = await blobToBase64(blob);
    let path: string | null = null;
    if (this.sessionId) {
      try {
        path = await invoke<string>("paste_attachment", {
          sessionId: this.sessionId,
          base64Data: data,
          mime: blob.type || "application/octet-stream",
        });
      } catch (err) {
        console.warn("[Composer] paste_attachment not available:", err);
      }
    }
    this.attachments.push({ mime: blob.type || "application/octet-stream", data, path, filename });
    this.renderAttachments();
    this.persistAttachments();
  }

  private onDragOver = (e: DragEvent): void => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    this.root.classList.add("drag-over");
  };

  private onDragLeave = (e: DragEvent): void => {
    e.stopPropagation();
    if (e.relatedTarget && this.root.contains(e.relatedTarget as Node)) return;
    this.root.classList.remove("drag-over");
  };

  private onDrop = async (e: DragEvent): Promise<void> => {
    e.preventDefault();
    e.stopPropagation();
    this.root.classList.remove("drag-over");
    this.root.closest(".view-sessions")?.classList.remove("drag-over");
    if (!e.dataTransfer?.files.length) return;
    for (const file of Array.from(e.dataTransfer.files)) {
      await this.attachBlob(file, file.name);
    }
  };

  async dropFiles(files: Iterable<File>): Promise<void> {
    for (const file of files) {
      await this.attachBlob(file, file.name);
    }
  }

  async attachFromPath(srcPath: string): Promise<void> {
    const filename = srcPath.split(/[\\/]/).pop() ?? srcPath;
    let result: { path: string; mime: string; base64: string } | null = null;
    if (this.sessionId) {
      try {
        result = await invoke<{ path: string; mime: string; base64: string }>(
          "paste_attachment_from_path",
          { sessionId: this.sessionId, path: srcPath },
        );
      } catch (err) {
        console.warn("[Composer] paste_attachment_from_path failed:", err);
      }
    }
    this.attachments.push({
      filename,
      mime: result?.mime ?? "application/octet-stream",
      data: result?.base64 ?? "",
      path: result?.path ?? null,
    });
    this.renderAttachments();
    this.persistAttachments();
  }

  private renderAttachments(): void {
    if (!this.attachmentsEl) return;
    this.attachmentsEl.innerHTML = "";
    this.attachments.forEach((a, i) => {
      const div = document.createElement("div");
      const isImage = a.mime.startsWith("image/");
      div.className = `attachment${isImage ? "" : " file-chip"}`;

      if (isImage) {
        const img = document.createElement("img");
        img.src = `data:${a.mime};base64,${a.data}`;
        img.alt = a.filename;
        img.addEventListener("click", () => openLightbox({ type: "image", mime: a.mime, base64: a.data, filename: a.filename }));
        div.appendChild(img);
      } else {
        const icon = mimeToIcon(a.mime);
        div.innerHTML = `<i class="ph ${icon}"></i>`;
        const label = document.createElement("span");
        label.textContent = a.filename;
        div.appendChild(label);
        div.addEventListener("click", () => openPreviewIfSupported(a));
      }

      const rm = document.createElement("button");
      rm.className = "rm";
      rm.title = "Remove";
      rm.innerHTML = '<i class="ph ph-x"></i>';
      rm.addEventListener("click", (e) => {
        e.stopPropagation();
        this.attachments.splice(i, 1);
        this.renderAttachments();
        this.persistAttachments();
      });
      div.appendChild(rm);
      this.attachmentsEl!.appendChild(div);
    });

    this.pastedBlocks.forEach((b, i) => {
      const div = document.createElement("div");
      div.className = "attachment file-chip pasted-log";
      div.title = "Pasted text — click to view";
      div.innerHTML = `<i class="ph ph-file-text"></i>`;
      const label = document.createElement("span");
      label.textContent = b.name;
      div.appendChild(label);
      div.addEventListener("click", () =>
        openLightbox({ type: "text", content: b.text, filename: b.name }),
      );

      const rm = document.createElement("button");
      rm.className = "rm";
      rm.title = "Remove";
      rm.innerHTML = '<i class="ph ph-x"></i>';
      rm.addEventListener("click", (e) => {
        e.stopPropagation();
        this.pastedBlocks.splice(i, 1);
        this.renderAttachments();
      });
      div.appendChild(rm);
      this.attachmentsEl!.appendChild(div);
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
    const empty = !text && this.attachments.length === 0 && this.pastedBlocks.length === 0;

    const builtin = text ? parseBuiltin(text) : null;
    if (builtin) {
      this.sending = true;
      const handler = HANDLERS[builtin.name];
      if (handler) {
        try {
          await handler(builtin, this.builtinCtx());
        } catch (e) {
          console.error("[builtin]", builtin.name, e);
        }
      }
      this.clearComposer();
      this.sending = false;
      return;
    }

    // While the turn is in flight: stage as a held message instead of sending.
    // Builtins above still run immediately; only real messages are held.
    if (this.opts.isBusy?.()) {
      if (empty) return;
      this.opts.onStage?.(this.buildBlocks(text));
      this.clearComposer();
      return;
    }

    // Not busy, but a held set exists: a normal send bundles the held messages
    // with this draft into ONE message (handled by the held controller).
    if (this.opts.hasHeld?.()) {
      const draftBlocks = empty ? [] : this.buildBlocks(text);
      this.clearComposer();
      this.opts.flushHeldWithDraft?.(draftBlocks);
      return;
    }

    if (empty) return;
    this.sending = true;
    const blocks = this.buildBlocks(text);
    this.clearComposer();
    try {
      await this.opts.onSend(blocks);
    } catch (err) {
      console.error("[Composer] onSend failed", err);
    } finally {
      this.sending = false;
    }
  }

  /** Build the ContentBlock[] for the current draft: typed text + any held
   * pasted-log sentinels + attachment <file:…> mentions. Pure (no clear). The
   * <pasted-log> wrapper is collapsed into a chip by the chat renderer so the
   * user never sees the wall of text in their own message. */
  private buildBlocks(text: string): ContentBlock[] {
    let fullText = text;
    for (const b of this.pastedBlocks) {
      const nonce = Math.random().toString(36).slice(2, 10);
      const wrapped = `<pasted-log id="${nonce}" name="${b.name}">\n${b.text}\n</pasted-log:${nonce}>`;
      fullText += (fullText ? "\n\n" : "") + wrapped;
    }
    // Mark voice-dictated messages so the model reads them charitably (homophones,
    // transcription noise); the renderer collapses this into a mic chip.
    if (this.voiceUsed) {
      fullText += (fullText ? "\n" : "") + "<voice-input/>";
    }
    const blocks: ContentBlock[] = [];
    if (fullText) blocks.push({ type: "text", text: fullText });
    for (const a of this.attachments) {
      if (a.path) {
        blocks.push({ type: "text", text: `<file:${a.path}::${a.filename}>` });
      } else {
        blocks.push({
          type: "text",
          text: "[attachment dropped - paste_attachment IPC not available]",
        });
      }
    }
    return blocks;
  }

  /** Reset the input, attachments, pasted blocks and persisted draft. Public so
   * the held-messages controller can clear after bundling the draft. */
  clearComposer(): void {
    if (this.textarea) this.textarea.value = "";
    this.autoResize();
    this.updateHighlight();
    this.attachments = [];
    this.pastedBlocks = [];
    // Reset voice state; stop an in-flight recording so a send mid-dictation
    // doesn't leave the controller running against stale anchor positions.
    this.voiceUsed = false;
    this.voiceCommitPos = 0;
    this.voiceVolatileLen = 0;
    if (this.voice?.isRecording) void this.voice.stop();
    this.renderAttachments();
    this.persistDraft();
    this.persistAttachments();
  }

  /** Build blocks for the current draft without clearing it (for bundling). */
  getDraftBlocks(): ContentBlock[] {
    const text = (this.textarea?.value ?? "").trim();
    if (this.isDraftEmpty()) return [];
    return this.buildBlocks(text);
  }

  isDraftEmpty(): boolean {
    const text = (this.textarea?.value ?? "").trim();
    return !text && this.attachments.length === 0 && this.pastedBlocks.length === 0;
  }

  /** True while the user is actively composing: focused with a non-empty draft,
   * or a keystroke within the last 2s. Gates auto-flush. */
  isComposing(): boolean {
    if (!this.textarea) return false;
    const hasText = (this.textarea.value ?? "").trim().length > 0;
    const focused = document.activeElement === this.textarea;
    if (focused && hasText) return true;
    return Date.now() - this.lastKeyAt < 2000;
  }

  private persistDraft(): void {
    if (!this.sessionId) return;
    const text = this.textarea?.value ?? "";
    if (text) saveDraft(this.sessionId, text);
    else clearDraft(this.sessionId);
  }
}

function openPreviewIfSupported(a: Attachment): void {
  if (!a.data) return;
  if (a.mime === "application/pdf") {
    openLightbox({ type: "pdf", base64: a.data, filename: a.filename });
  } else if (a.mime.startsWith("text/") || a.mime === "application/json") {
    try {
      const text = atob(a.data);
      openLightbox({ type: "text", content: text, filename: a.filename });
    } catch {
      /* non-UTF8 content, no preview */
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
