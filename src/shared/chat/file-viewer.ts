// Unified in-app file screen (ai_todo 95). One destination for "look at / work
// on a file" opened from in-chat Read / File-Changes rows and the statusbar
// tool-tally Files rows. Three modes under one surface:
//   - File: syntax-highlighted, read-only view of the current contents (slice 1)
//   - Diff: this session's edit(s) to the file, reusing the chat diff renderer
//           (slice 2) - tab only appears when the session edited this file
//   - Edit: inline editing of the File view, saved via write_text_file (slice 3)
// The external jump is preserved via the "Open in VS Code" header affordance.

import { invoke } from "../ipc";
import { basename } from "../path-utils";
import { escapeHtml } from "../escape-html";
// REUSE the existing full Shiki build (same highlighter the chat diffs use).
// The /web bundle lacks rust/toml/etc grammars, so this MUST stay /bundle/full.
import { codeToHtml } from "shiki/bundle/full";
import { renderStackedDiff } from "./edit-window";
import { enhanceEditDiffs } from "./diff-enhancer";
import type { FileEditView } from "./file-edits";
import type { TextFileData } from "../../types/ipc.generated";

type Tab = "file" | "diff";

interface ViewerState {
  path: string;
  edits: FileEditView[];
  tab: Tab;
  editing: boolean;
  loaded: TextFileData | null;
}

let overlay: HTMLDivElement | null = null;
let state: ViewerState | null = null;

// The active session's accrued file edits, registered by the sessions view so
// the Diff tab can resolve "this file's changes" from any entry point without
// threading them through every call site.
let editsProvider: (() => FileEditView[]) | null = null;
export function setFileEditsProvider(fn: (() => FileEditView[]) | null): void {
  editsProvider = fn;
}

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

  const edits = (editsProvider?.() ?? []).filter((e) => e.path === path);
  state = {
    path,
    edits,
    // Land on the Diff tab when the session changed this file (the point of
    // opening a File-Changes row); otherwise the read-only File view.
    tab: edits.length > 0 ? "diff" : "file",
    editing: false,
    loaded: null,
  };

  overlay = document.createElement("div");
  overlay.className = "file-viewer-overlay";
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeFileViewer();
  });

  const panel = document.createElement("div");
  panel.className = "file-viewer-panel";
  panel.appendChild(buildHeader(path));
  panel.appendChild(buildTabs());
  const body = document.createElement("div");
  body.className = "file-viewer-body";
  panel.appendChild(body);

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  document.addEventListener("keydown", onEsc);

  void renderBody();
}

function diffTotals(edits: FileEditView[]): { added: number; removed: number } {
  return edits.reduce(
    (acc, e) => ({ added: acc.added + e.addedLines, removed: acc.removed + e.removedLines }),
    { added: 0, removed: 0 },
  );
}

function buildHeader(path: string): HTMLElement {
  const header = document.createElement("div");
  header.className = "file-viewer-header";
  const name = basename(path);
  header.innerHTML =
    `<div class="file-viewer-title" title="${escapeHtml(path)}">` +
      `<i class="ph ph-file-text"></i>` +
      `<span class="file-viewer-name">${escapeHtml(name)}</span>` +
      `<span class="file-viewer-path">${escapeHtml(path)}</span>` +
    `</div>` +
    `<div class="file-viewer-actions"></div>`;
  renderActions(header.querySelector<HTMLElement>(".file-viewer-actions")!);
  return header;
}

// The action buttons depend on mode (viewing vs editing), so they are rebuilt
// whenever the mode changes rather than wired once.
function renderActions(actions: HTMLElement): void {
  if (!state) return;
  const editable = state.tab === "file" && state.loaded !== null && !state.loaded.truncated;

  if (state.editing) {
    actions.innerHTML =
      `<button class="file-viewer-ext file-viewer-save" type="button" title="Save changes">` +
        `<i class="ph ph-floppy-disk"></i><span>Save</span>` +
      `</button>` +
      `<button class="file-viewer-ext file-viewer-cancel" type="button" title="Discard changes">` +
        `<i class="ph ph-x-circle"></i><span>Cancel</span>` +
      `</button>`;
    actions.querySelector<HTMLButtonElement>(".file-viewer-save")?.addEventListener("click", () => void saveEdits());
    actions.querySelector<HTMLButtonElement>(".file-viewer-cancel")?.addEventListener("click", () => {
      if (!state) return;
      state.editing = false;
      void renderBody();
    });
    return;
  }

  const editBtn = editable
    ? `<button class="file-viewer-ext file-viewer-edit" type="button" title="Edit this file">` +
        `<i class="ph ph-pencil-simple"></i><span>Edit</span>` +
      `</button>`
    : "";
  actions.innerHTML =
    editBtn +
    `<button class="file-viewer-ext file-viewer-open-ext" type="button" title="Open in VS Code">` +
      `<i class="ph ph-arrow-square-out"></i><span>Open in VS Code</span>` +
    `</button>` +
    `<button class="file-viewer-close" type="button" aria-label="Close">` +
      `<i class="ph ph-x"></i>` +
    `</button>`;
  actions.querySelector<HTMLButtonElement>(".file-viewer-edit")?.addEventListener("click", () => {
    if (!state) return;
    state.editing = true;
    void renderBody();
  });
  actions.querySelector<HTMLButtonElement>(".file-viewer-open-ext")?.addEventListener("click", () => {
    if (!state) return;
    void invoke<void>("open_in_editor", { path: state.path }).catch((err) =>
      console.error("[file-viewer] open_in_editor failed", err),
    );
  });
  actions.querySelector<HTMLButtonElement>(".file-viewer-close")?.addEventListener("click", closeFileViewer);
}

function buildTabs(): HTMLElement {
  const tabs = document.createElement("div");
  tabs.className = "file-viewer-tabs";
  if (!state) return tabs;
  const hasDiff = state.edits.length > 0;
  // With no session edits there's nothing to compare against, so the lone File
  // tab adds only chrome - render the body directly instead.
  if (!hasDiff) {
    tabs.hidden = true;
    return tabs;
  }
  const { added, removed } = diffTotals(state.edits);
  const badge =
    `<span class="file-viewer-tab-diff">` +
    (added > 0 ? `<span class="diff-add">+${added}</span>` : "") +
    (removed > 0 ? `<span class="diff-del">-${removed}</span>` : "") +
    `</span>`;
  tabs.innerHTML =
    `<button class="file-viewer-tab" data-tab="diff" type="button">Diff ${badge}</button>` +
    `<button class="file-viewer-tab" data-tab="file" type="button">File</button>`;
  tabs.querySelectorAll<HTMLButtonElement>(".file-viewer-tab").forEach((btn) => {
    btn.classList.toggle("file-viewer-tab--active", btn.dataset.tab === state!.tab);
    btn.addEventListener("click", () => {
      if (!state || state.tab === btn.dataset.tab) return;
      state.tab = (btn.dataset.tab as Tab) ?? "file";
      state.editing = false;
      tabs.querySelectorAll<HTMLButtonElement>(".file-viewer-tab").forEach((b) =>
        b.classList.toggle("file-viewer-tab--active", b.dataset.tab === state!.tab),
      );
      void renderBody();
    });
  });
  return tabs;
}

function refreshActions(): void {
  const actions = overlay?.querySelector<HTMLElement>(".file-viewer-actions");
  if (actions) renderActions(actions);
}

async function renderBody(): Promise<void> {
  if (!overlay || !state) return;
  const body = overlay.querySelector<HTMLElement>(".file-viewer-body");
  if (!body) return;

  if (state.tab === "diff") {
    renderDiff(body);
    refreshActions();
    return;
  }

  // File tab. Editing needs the full content first; load it if we haven't.
  if (state.loaded === null) {
    body.innerHTML = `<div class="file-viewer-loading">Loading...</div>`;
    try {
      state.loaded = await invoke<TextFileData>("read_text_file", { path: state.path });
    } catch (err) {
      body.innerHTML = `<div class="file-viewer-error">${escapeHtml(String(err))}</div>`;
      return;
    }
    if (!overlay || !overlay.contains(body) || !state) return;
  }

  if (state.editing) {
    renderEditor(body, state.loaded.content);
  } else {
    await renderFileView(body, state.loaded);
  }
  refreshActions();
}

function renderDiff(body: HTMLElement): void {
  if (!state) return;
  body.innerHTML =
    `<div class="file-viewer-diff">${renderStackedDiff(state.edits)}</div>`;
  const diffEl = body.querySelector<HTMLElement>(".file-viewer-diff");
  if (diffEl) void enhanceEditDiffs(diffEl);
}

function renderEditor(body: HTMLElement, content: string): void {
  body.innerHTML = `<textarea class="file-viewer-edit" spellcheck="false"></textarea>`;
  const ta = body.querySelector<HTMLTextAreaElement>(".file-viewer-edit");
  if (ta) {
    ta.value = content;
    ta.focus();
  }
}

async function renderFileView(body: HTMLElement, data: TextFileData): Promise<void> {
  if (!state) return;
  const lang = langFromPath(state.path);
  let highlighted: string;
  try {
    highlighted = await codeToHtml(data.content, { lang, theme: "github-dark" });
  } catch {
    if (!overlay || !overlay.contains(body)) return;
    body.innerHTML = `<pre class="file-viewer-plain"></pre>`;
    const pre = body.querySelector("pre");
    if (pre) pre.textContent = data.content;
    appendTruncationNotice(body, data.truncated);
    return;
  }
  if (!overlay || !overlay.contains(body)) return;
  body.innerHTML = highlighted;
  appendTruncationNotice(body, data.truncated);
}

async function saveEdits(): Promise<void> {
  if (!overlay || !state) return;
  const ta = overlay.querySelector<HTMLTextAreaElement>(".file-viewer-edit");
  if (!ta || !state.loaded) return;
  const content = ta.value;
  const saveBtn = overlay.querySelector<HTMLButtonElement>(".file-viewer-save");
  if (saveBtn) saveBtn.disabled = true;
  try {
    await invoke<void>("write_text_file", { path: state.path, content });
  } catch (err) {
    if (saveBtn) saveBtn.disabled = false;
    const body = overlay.querySelector<HTMLElement>(".file-viewer-body");
    if (body && !body.querySelector(".file-viewer-error")) {
      body.insertAdjacentHTML(
        "afterbegin",
        `<div class="file-viewer-error">Save failed: ${escapeHtml(String(err))}</div>`,
      );
    }
    return;
  }
  if (!state) return;
  state.loaded = { content, truncated: state.loaded.truncated };
  state.editing = false;
  await renderBody();
}

function appendTruncationNotice(body: HTMLElement, truncated: boolean): void {
  if (!truncated) return;
  const notice = document.createElement("div");
  notice.className = "file-viewer-truncated";
  notice.innerHTML =
    `<i class="ph ph-warning"></i> File is large and was truncated. ` +
    `Open in VS Code to see (and edit) the full contents.`;
  body.appendChild(notice);
}

export function closeFileViewer(): void {
  if (!overlay) return;
  overlay.remove();
  overlay = null;
  state = null;
  document.removeEventListener("keydown", onEsc);
}

function onEsc(e: KeyboardEvent): void {
  if (e.key === "Escape") closeFileViewer();
}
