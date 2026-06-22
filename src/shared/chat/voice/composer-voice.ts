// Voice dictation state machine for the Composer, split out of composer.ts.
// Owns the VoiceController lifecycle, positional tracking (commitPos/volatileLen),
// and the mic button visual state. Composer delegates all voice concerns here.

import { VoiceController, type VoiceState } from "./controller";

export interface ComposerVoiceCallbacks {
  /** Full edit: autoResize + updateHighlight + persistDraft + onDraftActivity. */
  onAfterEdit: () => void;
  /** State-change only: updateHighlight (no resize/persist needed). */
  onHighlightOnly: () => void;
}

export class ComposerVoice {
  state: VoiceState = "idle";
  commitPos = 0;
  volatileLen = 0;
  isUsed = false;

  private controller: VoiceController | null = null;
  private micBtn: HTMLButtonElement | null = null;
  private textarea: HTMLTextAreaElement | null = null;
  private cb: ComposerVoiceCallbacks;

  constructor(cb: ComposerVoiceCallbacks) {
    this.cb = cb;
  }

  mount(micBtn: HTMLButtonElement, textarea: HTMLTextAreaElement): void {
    this.micBtn = micBtn;
    this.textarea = textarea;
    this.applyState();
  }

  async toggle(insertPos: number): Promise<void> {
    if (!this.controller) {
      this.controller = new VoiceController({
        onPartial: (t) => this.onPartial(t),
        onFinal: (t) => this.onFinal(t),
        onError: (m) => this.onError(m),
        onStateChange: (s) => this.onStateChange(s),
      });
    }
    if (this.controller.isRecording) {
      await this.controller.stop();
      return;
    }
    this.commitPos = insertPos;
    this.volatileLen = 0;
    await this.controller.start();
  }

  reset(): void {
    this.isUsed = false;
    this.commitPos = 0;
    this.volatileLen = 0;
    if (this.controller?.isRecording) void this.controller.stop();
  }

  destroy(): void {
    void this.controller?.destroy();
    this.controller = null;
  }

  applyState(): void {
    if (!this.micBtn) return;
    this.micBtn.classList.toggle("recording", this.state === "recording");
    this.micBtn.classList.toggle("connecting", this.state === "connecting");
  }

  private onStateChange(s: VoiceState): void {
    this.state = s;
    if ((s === "idle" || s === "error") && this.volatileLen > 0 && this.textarea) {
      const v = this.textarea.value;
      this.textarea.value =
        v.slice(0, this.commitPos) + v.slice(this.commitPos + this.volatileLen);
      this.volatileLen = 0;
    }
    this.applyState();
    this.cb.onHighlightOnly();
  }

  private onPartial(text: string): void {
    if (!this.textarea) return;
    const v = this.textarea.value;
    this.textarea.value =
      v.slice(0, this.commitPos) + text + v.slice(this.commitPos + this.volatileLen);
    this.volatileLen = text.length;
    this.textarea.selectionStart = this.textarea.selectionEnd = this.commitPos + this.volatileLen;
    this.isUsed = true;
    this.cb.onAfterEdit();
  }

  private onFinal(text: string): void {
    if (!this.textarea || !text) return;
    const v = this.textarea.value;
    const before = v.slice(0, this.commitPos);
    const after = v.slice(this.commitPos + this.volatileLen);
    this.textarea.value = before + text + after;
    this.commitPos += text.length;
    this.volatileLen = 0;
    this.textarea.selectionStart = this.textarea.selectionEnd = this.commitPos;
    this.isUsed = true;
    this.cb.onAfterEdit();
  }

  private onError(message: string): void {
    console.warn("[voice]", message);
    if (this.micBtn) this.micBtn.title = `Voice error: ${message}`;
  }
}
