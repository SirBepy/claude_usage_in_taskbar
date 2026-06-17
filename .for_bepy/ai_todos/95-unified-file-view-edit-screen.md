# Unified in-app file view/edit screen

## Status (autopilot 2026-06-17)
**Slice 1 SHIPPED (commit 731d0e6, absorbed ai_todo 35).** Read-only Shiki file viewer (`src/shared/chat/file-viewer.ts`, `openFileViewer(path)`) + Rust IPC `read_text_file(path) -> { content, truncated }` (2MB cap, `src-tauri/src/ipc/misc.rs`). All file-row clicks re-pointed to it: in-chat Read/File-Changes chips (`handleToolFileClick`) and the statusbar tool-tally Files rows (`session-tally.ts`); "Open in VS Code" kept as a secondary affordance in the viewer header; images still use `openLightbox`. tsc + cargo build clean, vitest green.
REMAINING: slice 2 (session-edit DIFF tab, reuse `renderEditWindow`/`FileEditView`) + slice 3 (inline EDIT). Build these under the same viewer surface.

## Decision (Joe, 2026-06-16)
**Build the full unified screen (this todo), not just a read-only viewer.** It's the single destination for all file rows: in-chat Read chips, File-Changes chips, AND the tool-tally popover rows (absorbs ai_todo 35). Recommended build order: (1) read-only Shiki view slice + `read_text_file` IPC, wire all file rows to it, keep "open in VS Code" as a secondary affordance; (2) session-edit diff view; (3) inline edit. Ship incrementally but under one screen/architecture.

## Goal

One in-app screen that becomes the single destination for "look at / work on a file" across the app: view the current file, view its diff(s) from this session's edits, and (future) edit it inline. The new in-chat Read and "File Changes" chip-panel rows should open THIS screen instead of shelling out to the external editor.

## Context

Added 2026-06-14 alongside the custom chip-panel views feature. The in-chat tool chips (`src/shared/chat/turn-collapse.ts`) now render aggregated custom views:
- "File Changes" chip (combined Edit/Write/MultiEdit/NotebookEdit) -> one row per file with a change count.
- "Read" chip -> one row per file with a read count.

Both kinds of row currently open the file via the Rust IPC `open_in_editor` (external editor) - wired in `src/shared/chat/chat-renderer.ts` `handleToolFileClick` (delegated on `.tool-file-row[data-path]`). That external jump is the interim behavior Joe explicitly chose until this screen exists.

The rich inline diff card (`renderEditWindow` / `parseFileEdit` in `src/shared/chat/file-edits.ts`) used to render each edit inline in the chat. It is the natural BASIS for this screen's diff view - the data + rendering already exist. The session keeps a `fileEdits: FileEditView[]` index on `ChatRenderer` (`onFileEditsChanged`), already consumed by the Changes panel (`src/views/sessions/changes-panel.ts`).

Related but narrower: `35-in-app-file-image-viewer.md` (read-only Shiki viewer for the statusbar tally popover). This screen should likely SUPERSEDE/absorb 35 - decide whether to merge when picking this up rather than building two viewers.

## Approach

1. New screen/panel (route or sheet) that takes a path and a mode. Tabs/segments: "File" (current contents), "Diff" (this session's edits to it), and later "Edit".
2. Rust IPC `read_text_file(path) -> { content, truncated }` (mirror `read_image_file` in `src-tauri/src/ipc/misc.rs`, size-capped). Needs a matching capabilities/default.json entry only if it's a plugin/core ACL - a plain custom `#[command]` is authorized by `generate_handler` alone.
3. Diff view: reuse `renderEditWindow` against the `FileEditView` entries for that path (aggregate multiple edits to the same file into a stacked/sequential diff). Shiki must be the full/bundle build for highlighting.
4. Re-point `handleToolFileClick` (and the statusbar tally `open_in_editor` row clicks) at this screen. Keep an explicit "open externally" affordance per row so the VS Code path is not lost.
5. Images: keep `openLightbox`, or unify under the same screen.

## Acceptance

- Clicking a Read or File-Changes row in a chat chip panel opens this in-app screen (not an external editor) showing the file and, for changed files, the session's diff(s).
- An explicit "open externally" affordance still exists.
- Decision recorded on whether `35-in-app-file-image-viewer.md` is merged in or kept separate.
- `pnpm tsc --noEmit` clean; `cargo build --manifest-path src-tauri/Cargo.toml` clean.
