# Manual tasks for Joe

Numbered steps Joe needs to do by hand that can't be automated.

1. Drop mac/linux Piper binaries into `tauri/binaries/piper/` before building for those platforms. Download from https://github.com/rhasspy/piper/releases and rename to match Tauri's target-triple convention:

   - macOS x86_64: `piper-x86_64-apple-darwin`
   - macOS arm64: `piper-aarch64-apple-darwin`
   - Linux x86_64: `piper-x86_64-unknown-linux-gnu`

   Windows binary (`piper-x86_64-pc-windows-msvc.exe`) already present. Required for high-quality notification voices.
