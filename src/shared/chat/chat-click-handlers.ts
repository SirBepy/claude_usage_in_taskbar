import { base64ToUtf8 } from "./chat-transforms";
import { openLightbox } from "./lightbox";
import { chipToLightboxContent } from "./attachment-hydrator";
import { showView } from "../navigation";
import { escapeHtml } from "../escape-html";
import { invoke } from "../ipc";

let tableOverlay: HTMLDivElement | null = null;

function closeTableOverlay(): void {
  if (!tableOverlay) return;
  tableOverlay.remove();
  tableOverlay = null;
  document.removeEventListener("keydown", onTableEsc);
}

function onTableEsc(e: KeyboardEvent): void {
  if (e.key === "Escape") closeTableOverlay();
}

export function handleTableFullscreen(e: MouseEvent): void {
  const btn = (e.target as Element).closest<HTMLButtonElement>(".table-fs-btn");
  if (!btn) return;
  const wrap = btn.closest<HTMLElement>(".table-wrap");
  const table = wrap?.querySelector("table");
  if (!table) return;

  closeTableOverlay();

  tableOverlay = document.createElement("div");
  tableOverlay.className = "table-overlay";
  tableOverlay.addEventListener("click", (ev) => {
    if (ev.target === tableOverlay) closeTableOverlay();
  });

  const close = document.createElement("button");
  close.className = "table-overlay-close";
  close.setAttribute("aria-label", "Close");
  close.innerHTML = '<i class="ph ph-x"></i>';
  close.addEventListener("click", closeTableOverlay);

  const inner = document.createElement("div");
  inner.className = "table-overlay-inner";
  inner.appendChild(table.cloneNode(true));

  tableOverlay.appendChild(close);
  tableOverlay.appendChild(inner);
  document.body.appendChild(tableOverlay);
  document.addEventListener("keydown", onTableEsc);
}

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

let prModalOverlay: HTMLDivElement | null = null;

function closePrModal(): void {
  if (!prModalOverlay) return;
  prModalOverlay.remove();
  prModalOverlay = null;
  document.removeEventListener("keydown", onPrModalEsc);
}

function onPrModalEsc(e: KeyboardEvent): void {
  if (e.key === "Escape") closePrModal();
}

/** The "drag this screenshot into GitHub" stand-in shown when a local image
 * can't be inlined (unreadable path, non-image, or read failure). */
function prImgPlaceholder(): HTMLDivElement {
  const ph = document.createElement("div");
  ph.className = "pr-img-placeholder";
  ph.innerHTML = '<i class="ph ph-image"></i><span>Screenshot — drag into GitHub after creating the PR</span>';
  return ph;
}

const PR_IMG_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp",
};

/** Image mime for a local path by extension, or null if it isn't an image. */
function imageMimeFromPath(path: string): string | null {
  const m = path.toLowerCase().match(/\.([a-z0-9]+)(?:\?.*)?$/);
  return m ? (PR_IMG_MIME[m[1]!] ?? null) : null;
}

export function handlePrPreviewClick(e: MouseEvent): void {
  const btn = (e.target as Element).closest<HTMLButtonElement>(".pr-preview-btn");
  if (!btn) return;
  const card = btn.closest<HTMLElement>(".pr-preview-card");
  if (!card) return;
  const tmpl = card.querySelector<HTMLTemplateElement>("template.pr-modal-tpl");
  if (!tmpl) return;

  closePrModal();

  const overlay = document.createElement("div");
  overlay.className = "pr-modal-overlay";
  overlay.addEventListener("click", (ev) => { if (ev.target === overlay) closePrModal(); });
  prModalOverlay = overlay;

  const modal = document.createElement("div");
  modal.className = "pr-modal";

  const header = document.createElement("div");
  header.className = "pr-modal-header";
  const title = card.dataset.prTitle ?? "PR Preview";
  header.innerHTML = `<i class="ph ph-git-pull-request"></i><span class="pr-modal-title">${escapeHtml(title)}</span><button class="pr-modal-close" aria-label="Close"><i class="ph ph-x"></i></button>`;
  header.querySelector<HTMLButtonElement>(".pr-modal-close")!.addEventListener("click", closePrModal);

  const content = document.createElement("div");
  content.className = "pr-modal-content";
  content.appendChild(tmpl.content.cloneNode(true));

  // Images: remote URLs render directly (placeholder on 404). A local path
  // can't load inside the webview (CSP + no file://), but a data: URL CAN, so
  // read the file through the daemon and inline it as base64 to show the real
  // screenshot in the preview. (It still must be dragged into GitHub on PR
  // creation - GitHub won't resolve a local path either.) Any failure - bad
  // path, non-image, read error - falls back to the drag-it-in placeholder.
  content.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    const isRemote = src.startsWith("https://") || src.startsWith("http://") || src.startsWith("data:");
    if (isRemote) {
      img.addEventListener("error", () => img.replaceWith(prImgPlaceholder()));
      return;
    }
    const localPath = src.replace(/^file:\/\//, "");
    const mime = imageMimeFromPath(localPath);
    if (!mime) { img.replaceWith(prImgPlaceholder()); return; }
    void invoke<string>("read_file_as_base64", { path: localPath })
      .then((b64) => { img.src = `data:${mime};base64,${b64}`; })
      .catch(() => img.replaceWith(prImgPlaceholder()));
  });

  // Render mermaid code blocks as styled diagram placeholders. markdown-it
  // outputs <pre><code class="language-mermaid">; GitHub renders these
  // natively but the in-app modal doesn't have mermaid.js.
  content.querySelectorAll<HTMLElement>("code.language-mermaid").forEach((code) => {
    const pre = code.closest("pre");
    if (!pre) return;
    const source = code.textContent ?? "";
    const wrap = document.createElement("div");
    wrap.className = "pr-mermaid-placeholder";
    wrap.innerHTML = `<div class="pr-mermaid-header"><i class="ph ph-flow-arrow"></i><span>Diagram — renders on GitHub</span></div><pre class="pr-mermaid-source">${escapeHtml(source)}</pre>`;
    pre.replaceWith(wrap);
  });

  modal.appendChild(header);
  modal.appendChild(content);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  document.addEventListener("keydown", onPrModalEsc);
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

  if (btn.classList.contains("cell-copy-btn")) {
    const cell = btn.closest<HTMLElement>("td, th");
    if (!cell) return;
    const clone = cell.cloneNode(true) as HTMLElement;
    clone.querySelector(".cell-copy-btn")?.remove();
    text = clone.textContent ?? "";
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
    return;
  }

  const inlineWrap = btn.closest(".inline-code-wrap");
  if (inlineWrap) {
    text = inlineWrap.querySelector("code")?.textContent ?? "";
  } else {
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

      // Slack/Discord (Joe's actual paste targets) read the pasted <a>/<code>/
      // <strong> tags themselves, not computed CSS - so write real semantic
      // HTML directly rather than relying on execCommand('copy')'s Range-based
      // browser capture, which WebView2 has been dropping to plain-text-only.
      const clone = msg.cloneNode(true) as HTMLElement;
      clone.querySelector(".msg-copy-btn")?.remove();
      const html = clone.innerHTML;
      const plain = clone.textContent ?? "";

      void navigator.clipboard
        .write([
          new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([plain.trim()], { type: "text/plain" }),
          }),
        ])
        .then(() => {
          const icon = btn.querySelector("i");
          if (!icon) return;
          icon.className = "ph ph-check";
          btn.classList.add("copied");
          setTimeout(() => {
            icon.className = "ph ph-copy";
            btn.classList.remove("copied");
          }, 1500);
        });
      return;
    }
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
