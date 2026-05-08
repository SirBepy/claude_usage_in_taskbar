# Phase 6 - Image paste

## Context

Implements Tasks 6.1 + 6.2 of `docs/superpowers/plans/2026-05-07-claude-chat-hub.md`. Depends on Phases 4 (IPC) + 5b (composer). Read "PHASE 6 - Image paste" in the parent plan.

Path C: claude `-p` accepts a single prompt string. There's no inline image content block channel. The composer writes pasted images to disk under `<app-data>/chat-attachments/<session_id>/<uuid>.png` and inserts `<file:<absolute-path>>` text into the prompt. claude reads the image via its Read tool.

## Goal

Backend: add `paste_image` IPC command + `write_attachment` pure helper + a unit test. Add `base64` and `uuid` deps if not already present.

Frontend: composer captures the file path returned from `paste_image`, stores it on the attachment, and on `send()` pushes a `text` block with `<file:${a.path}>` text instead of an `image` block.

## Implementation

Backend (`src-tauri/src/ipc/chat.rs`):

1. Verify `base64 = "0.22"` and `uuid = { version = "1", features = ["v4"] }` in `[dependencies]`. Add if missing.
2. Pull the file-writing logic into a pure free function for testability:
   ```rust
   pub(crate) fn write_attachment(
       root: &std::path::Path,
       session_id: &str,
       base64_data: &str,
       mime: &str,
   ) -> Result<std::path::PathBuf, String> {
       use base64::Engine;
       let dir = root.join("chat-attachments").join(session_id);
       std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
       let bytes = base64::engine::general_purpose::STANDARD
           .decode(base64_data.as_bytes()).map_err(|e| e.to_string())?;
       let ext = match mime {
           "image/png" => "png",
           "image/jpeg" | "image/jpg" => "jpg",
           "image/gif" => "gif",
           "image/webp" => "webp",
           _ => "bin",
       };
       let filename = format!("{}.{}", uuid::Uuid::new_v4(), ext);
       let path = dir.join(&filename);
       std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
       Ok(path)
   }
   ```
3. Add the Tauri command:
   ```rust
   #[tauri::command]
   pub async fn paste_image(
       session_id: String,
       base64_data: String,
       mime: String,
       app: tauri::AppHandle,
   ) -> Result<String, String> {
       let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
       let path = write_attachment(&app_data, &session_id, &base64_data, &mime)?;
       Ok(path.to_string_lossy().to_string())
   }
   ```
4. Append a unit test in `ipc::chat::tests`:
   ```rust
   #[test]
   fn write_attachment_decodes_png() {
       let tmp = tempfile::tempdir().unwrap();
       let png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
       let path = write_attachment(tmp.path(), "sess", png_b64, "image/png").unwrap();
       assert!(path.exists());
       assert!(path.extension().map(|e| e == "png").unwrap_or(false));
       let data = std::fs::read(&path).unwrap();
       assert_eq!(&data[..8], &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]); // PNG signature
   }
   ```
5. Register `paste_image` in `lib.rs` invoke handler. Add to capabilities/default.json.
6. Run `cargo test -p claude-usage-tauri --lib`. Expect 175 (174 + 1 new).

Frontend (`src/modules/composer.js`):

1. The composer's `onPaste` already calls `invoke('paste_image', ...)`. Now that the IPC works, remove the try/catch placeholder added in Phase 5b. Just call it normally and push the resulting path:
   ```js
   const filePath = await invoke('paste_image', { sessionId: this.sessionId, base64Data: data, mime: blob.type });
   this.attachments.push({ mime: blob.type, data, path: filePath });
   ```
2. In `send()`, change the loop that builds blocks:
   ```js
   if (text) blocks.push({ type: 'text', text });
   for (const a of this.attachments) {
     blocks.push({ type: 'text', text: `<file:${a.path}>` });
   }
   ```
   Don't push `image` blocks at all anymore.

## Gotchas

- `tempfile = "3"` is already in `[dev-dependencies]` per Cargo.toml. Use it for the test.
- `uuid::Uuid::new_v4()` requires the `v4` feature - confirm in Cargo.toml.
- Capabilities file: match existing entry shape. The `tauri::AppHandle` in `paste_image` requires the `core:default` set or similar; check by building and seeing if a runtime permission error fires (we can't test runtime here without `cargo tauri dev`, so just match the shape of other commands like `start_session` from Phase 4).

## Don't

- Don't commit.
- Don't keep the `image` ContentBlock branch logic in the composer's send loop.
- Don't add image preview thumbnails beyond what Phase 5b already drew (those still work since `attachments[].data` is still the base64).

## Acceptance

- 175 lib tests pass.
- `paste_image` IPC works end-to-end: composer paste -> Rust writes file -> path returned -> mention text in next send.
- `chat-attachments/<session>/<uuid>.png` files appear under `<app-data>` after a paste.
- Phase 6 manual repro is SKIPPED per night-run pre-decision.
