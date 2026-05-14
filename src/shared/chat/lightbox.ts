export type LightboxContent =
  | { type: "image"; mime: string; base64: string; filename?: string }
  | { type: "pdf"; base64: string; filename?: string }
  | { type: "text"; content: string; filename?: string };

let overlay: HTMLDivElement | null = null;

export function openLightbox(content: LightboxContent): void {
  closeLightbox();

  overlay = document.createElement("div");
  overlay.className = "lightbox-overlay";
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeLightbox();
  });

  const close = document.createElement("button");
  close.className = "lightbox-close";
  close.setAttribute("aria-label", "Close preview");
  close.innerHTML = '<i class="ph ph-x"></i>';
  close.addEventListener("click", closeLightbox);

  const inner = document.createElement("div");
  inner.className = "lightbox-content";

  if (content.type === "image") {
    const img = document.createElement("img");
    img.src = `data:${content.mime};base64,${content.base64}`;
    img.alt = content.filename ?? "";
    inner.appendChild(img);
  } else if (content.type === "pdf") {
    const blob = b64toBlob(content.base64, "application/pdf");
    const url = URL.createObjectURL(blob);
    const embed = document.createElement("embed");
    embed.src = url;
    embed.type = "application/pdf";
    inner.appendChild(embed);
    overlay.dataset.blobUrl = url;
  } else {
    const pre = document.createElement("pre");
    pre.textContent = content.content;
    inner.appendChild(pre);
  }

  overlay.appendChild(close);
  overlay.appendChild(inner);
  document.body.appendChild(overlay);
  document.addEventListener("keydown", onEsc);
}

export function closeLightbox(): void {
  if (!overlay) return;
  const url = overlay.dataset.blobUrl;
  if (url) URL.revokeObjectURL(url);
  overlay.remove();
  overlay = null;
  document.removeEventListener("keydown", onEsc);
}

function onEsc(e: KeyboardEvent): void {
  if (e.key === "Escape") closeLightbox();
}

function b64toBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
