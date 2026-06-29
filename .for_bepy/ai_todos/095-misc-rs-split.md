# misc.rs should be split

## Goal
Break `src-tauri/src/ipc/misc.rs` (435 lines) into focused modules so the file is under 250 lines and each module has a single concern.

## Context
`src-tauri/src/ipc/misc.rs` is 435 lines and mixes five distinct concerns:
- Session/chat config lookups (`get_session_config`, `list_auto_accept`) — lines 1-21
- App lifecycle (`quit_app`, `frontend_ready`) — lines 22-100
- Log utilities (`read_log_contents`, `read_log_file`, `copy_logs`) — lines 34-73
- Version/system info (`get_platform`, `get_app_version`, `get_version_info`, `load_or_record_install_date`) — lines 94-220
- File/folder commands (`pick_folder`, `create_folder`, `open_external`, `open_in_editor`, `open_in_vscode`, `open_in_explorer`, `read_image_file`, `read_text_file`, `write_text_file`) — lines 221-365
- Audio preview commands (`piper_status`, `piper_install_voice`, `piper_speak_preview`, `play_sound_preview`) — lines 366-435

## Approach
1. Create `src-tauri/src/ipc/files.rs` — move the file/folder and log commands.
2. Create `src-tauri/src/ipc/audio_preview.rs` — move the piper/sound commands.
3. Keep `misc.rs` for app lifecycle (`quit_app`, `frontend_ready`) and small one-liners that don't fit elsewhere.
4. Update `src-tauri/src/ipc/mod.rs` to re-export from the new modules.
5. All `#[tauri::command]` registrations in `lib.rs`'s `invoke_handler` stay the same (they reference the fully-qualified function, not the module path).

## Acceptance
- `cargo build` passes.
- `misc.rs` is under 250 lines.
- Each new file has a single-concern comment at the top.
