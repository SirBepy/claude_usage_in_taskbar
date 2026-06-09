# In-app viewer for files/images opened from the tool-tally popover

## Goal

Replace the external "open in VS Code" jump with an in-app viewer, so clicking a file the agent read/edited (or an image) stays inside the Companion app instead of shelling out to `code <path>`.

## Context

Shipped 2026-06-10 in the tool-call-activity feature: the ccstatusline tally row's Files|Media popover (`src/views/sessions/session-statusbar.ts`) opens files via the Rust IPC `open_in_editor` (spawns VS Code) and images via the existing in-app `openLightbox`. Joe said at design time he wants to "handle it all in this app" eventually rather than bounce to VS Code.

## Approach

Add an in-app file viewer (read-only code view): a new Rust IPC `read_text_file(path) -> { content, truncated }` (mirror `read_image_file` in `src-tauri/src/ipc/misc.rs`, cap size), and a frontend panel/lightbox that renders it with the existing Shiki highlighter (already a dependency). Wire the Files-tab row click to this panel instead of `invoke("open_in_editor")`. Keep `open_in_editor` as a secondary "open externally" affordance (e.g. a small icon-button per row) so the VS Code path isn't lost. Images already use `openLightbox` — leave them, or unify both under one viewer.

## Acceptance

- Clicking a file row opens it inside the app (syntax-highlighted, read-only), no VS Code window.
- An explicit "open in VS Code" affordance still exists per row.
- `pnpm tsc --noEmit` clean; cargo build clean.
