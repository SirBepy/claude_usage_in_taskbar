// Read-only, syntax-highlighted in-app file viewer (ai_todo 95 slice 1).
// Routes the "open a file" row clicks here instead of shelling out to an
// external editor. The external jump is preserved via the "Open in VS Code"
// affordance in the viewer header.
//
// Slice 1 is read-only: no diff tab, no inline editing (later slices).

import { invoke } from "../ipc";
import { basename } from "../path-utils";
import { escapeHtml } from "../escape-html";
// REUSE the existing full Shiki build (same highlighter the chat diffs use).
// The /web bundle lacks rust/toml/etc grammars, so this MUST stay /bundle/full.
import { codeToHtml } from "shiki/bundle/full";
import type { TextFileData } from "../../types/ipc.generated";

let overlay: HTMLDivElement | null = null;

// Map a file extension to a Shiki language id. Unknown extensions fall back to
// "text" (Shiki renders it as plain, no highlighting).
function langFromPath(path: string): string {
  const name = basename(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1) : "";
  const map: Record<string, string> = {
    ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mjs: "js", cjs: "js",
    rs: "rust", toml: "toml", json: "json", jsonc: "jsonc",
    md: "markdown", markdown: "markdown", mdx: "mdx",
    html: "html", htm: "html", css: "css", scss: "scss", sass: "sass",
    py: "python", rb: "ruby", go: "go", java: "java", kt: "kotlin",
    c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp",
    cs: "csharp", php: "php", swift: "swift", lua: "lua",
    sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell",
    yml: "yaml", yaml: "yaml", xml: "xml", svg: "xml", sql: "sql",
    vue: "vue", svelte: "svelte", dart: "dart",
  };
  return map[ext] ?? "text";
}

export function openFileViewer(path: string): void {
  closeFileViewer();

  overlay = document.createElement("div");
  overlay.className = "file-viewer-overlay";
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeFileViewer();
  });

  const panel = document.createElement("div");
  panel.className = "file-viewer-panel";

  const header = document.createElement("div");
  header.className = "file-viewer-header";

  const name = basename(path);
  header.innerHTML =
    `<div class="file-viewer-title" title="${escapeHtml(path)}">` +
      `<i class="ph ph-file-text"></i>` +
      `<span class="file-viewer-name">${escapeHtml(name)}</span>` +
      `<span class="file-viewer-path">${escapeHtml(path)}</span>` +
    `</div>` +
    `<div class="file-viewer-actions">` +
      `<button class="file-viewer-ext" type="button" title="Open in VS Code">` +
        `<i class="ph ph-arrow-square-out"></i><span>Open in VS Code</span>` +
      `</button>` +
      `<button class="file-viewer-close" type="button" aria-label="Close">` +
        `<i class="ph ph-x"></i>` +
      `</button>` +
    `</div>`;

  header.querySelector<HTMLButtonElement>(".file-viewer-ext")?.addEventListener("click", () => {
    void invoke<void>("open_in_editor", { path }).catch((err) =>
      console.error("[file-viewer] open_in_editor failed", err),
    );
  });
  header.querySelector<HTMLButtonElement>(".file-viewer-close")?.addEventListener("click", closeFileViewer);

  const body = document.createElement("div");
  body.className = "file-viewer-body";
  body.innerHTML = `<div class="file-viewer-loading">Loading...</div>`;

  panel.appendChild(header);
  panel.appendChild(body);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  document.addEventListener("keydown", onEsc);

  void loadInto(body, path);
}

async function loadInto(body: HTMLElement, path: string): Promise<void> {
  let data: TextFileData;
  try {
    data = await invoke<TextFileData>("read_text_file", { path });
  } catch (err) {
    body.innerHTML = `<div class="file-viewer-error">${escapeHtml(String(err))}</div>`;
    return;
  }
  // The viewer may have been closed (or replaced) while awaiting.
  if (!overlay || !overlay.contains(body)) return;

  const lang = langFromPath(path);
  let highlighted: string;
  try {
    highlighted = await codeToHtml(data.content, { lang, theme: "github-dark" });
  } catch {
    highlighted = `<pre class="file-viewer-plain"></pre>`;
    if (!overlay || !overlay.contains(body)) return;
    body.innerHTML = highlighted;
    const pre = body.querySelector("pre");
    if (pre) pre.textContent = data.content;
    appendTruncationNotice(body, data.truncated);
    return;
  }
  if (!overlay || !overlay.contains(body)) return;
  body.innerHTML = highlighted;
  appendTruncationNotice(body, data.truncated);
}

function appendTruncationNotice(body: HTMLElement, truncated: boolean): void {
  if (!truncated) return;
  const notice = document.createElement("div");
  notice.className = "file-viewer-truncated";
  notice.innerHTML =
    `<i class="ph ph-warning"></i> File is large and was truncated. ` +
    `Open in VS Code to see the full contents.`;
  body.appendChild(notice);
}

export function closeFileViewer(): void {
  if (!overlay) return;
  overlay.remove();
  overlay = null;
  document.removeEventListener("keydown", onEsc);
}

function onEsc(e: KeyboardEvent): void {
  if (e.key === "Escape") closeFileViewer();
}
