import { base64ToUtf8 } from "./chat-transforms";
import { openLightbox } from "./lightbox";
import { chipToLightboxContent } from "./attachment-hydrator";
import { showView } from "../navigation";

export function handlePastedLogClick(e: MouseEvent): void {
  const chip = (e.target as Element).closest<HTMLElement>(".pasted-log-chip");
  if (!chip) return;
  const name = chip.dataset.pastedName || "pasted_log.txt";
  const text = base64ToUtf8(chip.dataset.pastedText || "");
  openLightbox({ type: "text", content: text, filename: name });
}

export function handleSlashClick(e: MouseEvent): void {
  const span = (e.target as Element).closest<HTMLElement>(".slash-mention[data-skill-target]");
  if (!span) return;
  // Detached chat windows live on a `#detached?...` route - navigating
  // would discard the chat. Skip; future: open the main window's view via Tauri instead.
  if (window.location.hash.startsWith("#detached")) return;
  const target = span.dataset.skillTarget;
  if (!target) return;
  e.preventDefault();
  (window as unknown as { skillDetailTarget?: string }).skillDetailTarget = target;
  showView("skill-detail");
}

export function handleAttachmentClick(e: MouseEvent): void {
  const chip = (e.target as Element).closest<HTMLElement>(".attachment-chip.previewable");
  if (!chip) return;
  const content = chipToLightboxContent(chip);
  if (content) openLightbox(content);
}

export function handleCopyClick(e: MouseEvent): void {
  const btn = (e.target as Element).closest(".copy-btn") as HTMLButtonElement | null;
  if (!btn) return;

  let text = "";
  const block = btn.closest(".copyable-block");
  if (block) {
    const shikiPre = block.querySelector<HTMLElement>("pre.shiki");
    const fallbackPre = block.querySelector<HTMLElement>("pre");
    const pre = shikiPre ?? fallbackPre;
    if (pre) {
      text = pre.textContent ?? "";
    } else {
      const clone = block.cloneNode(true) as HTMLElement;
      clone.querySelector(".copy-btn")?.remove();
      text = clone.textContent ?? "";
    }
  } else {
    const msg = btn.closest(".msg") as HTMLElement | null;
    if (!msg) return;
    const clone = msg.cloneNode(true) as HTMLElement;
    clone.querySelector(".msg-copy-btn")?.remove();
    text = clone.textContent ?? "";
  }

  void navigator.clipboard.writeText(text.trim()).then(() => {
    const icon = btn.querySelector("i");
    if (!icon) return;
    icon.className = "ph ph-check";
    btn.classList.add("copied");
    setTimeout(() => {
      icon.className = "ph ph-copy";
      btn.classList.remove("copied");
    }, 1500);
  });
}
