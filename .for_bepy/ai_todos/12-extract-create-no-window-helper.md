# Share CREATE_NO_WINDOW spawn flag across Windows process invocations

## Goal

One canonical place for the `CREATE_NO_WINDOW` constant + the `cmd.creation_flags(...)` block; reused by every Windows `Command::new` site instead of being copy-pasted.

## Context

The flag is currently set in two places:

- `src-tauri/src/chat/runner.rs:91-94` (claude turn spawn)
- `src-tauri/src/ipc/misc.rs:195-200` (git in get_git_info)

Both define `const CREATE_NO_WINDOW: u32 = 0x0800_0000;` locally and apply it via `std::os::windows::process::CommandExt::creation_flags`. Other spawn sites (auth/login_flow.rs, channels/spawn.rs, ipc/projects.rs) may or may not need it — auditing them is part of ai_todo #14 below.

## Approach

Add a thin helper module, e.g. `src-tauri/src/util/process.rs`:

```rust
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Apply Windows-only console-suppression flag. No-op on other platforms.
pub fn hide_console(cmd: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}
```

Replace the inline blocks in `chat/runner.rs` and `ipc/misc.rs` with `crate::util::process::hide_console(&mut cmd)`. Update `lib.rs` to declare the new `util` module.

## Acceptance

- Only one definition of `CREATE_NO_WINDOW` remains in the tree (grep confirms).
- All cargo tests pass.
- Manual: `cargo tauri dev`, send a message + open a session — no console flashes on Windows; behavior unchanged on macOS/Linux.
