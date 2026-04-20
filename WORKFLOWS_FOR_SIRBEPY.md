# Manual tasks for Joe

Numbered steps Joe needs to do by hand that can't be automated.

1. Drop mac/linux Piper binaries into `tauri/binaries/piper/` before building for those platforms. Download from https://github.com/rhasspy/piper/releases and rename to match Tauri's target-triple convention:

   - macOS x86_64: `piper-x86_64-apple-darwin`
   - macOS arm64: `piper-aarch64-apple-darwin`
   - Linux x86_64: `piper-x86_64-unknown-linux-gnu`

   Windows binary (`piper-x86_64-pc-windows-msvc.exe`) already present. Required for high-quality notification voices.

2. Smoke test the per-project notifications + sound packs feature:

   a. Launch the app (`npm --prefix tauri run tauri dev` or built binary).
   b. Notifications subpage: each card shows Pack + Sound dropdowns. Default pack lists 6 sounds. ▶ preview plays.
   c. Switch Pack dropdown to "Peon (Orc) (not installed)" → Install button appears → click → wait → Peon sounds populate, button hides. (Requires step 3 below done first.)
   d. Open a project's detail page. Confirm 3 override rows (Done, Waiting, Threshold Reached), all toggled off by default.
   e. Trigger a hook for that project → default sound plays.
   f. Toggle Done override on, pick Peon → `work-work.mp3`. Fire a hook for that project → "Work work" plays.
   g. Switch same override to Voice mode, pick a voice, set template `{name} done` → fire hook → voice speaks.
   h. Different project: confirm Project A uses override, Project B uses default.
   i. Close app, delete `<app-data>/sound-packs/peon/`, reopen → preview on Peon override falls back silently (log warns).

3. Host sound pack zip assets on a GitHub release tagged `sound-packs-v1` so `install_sound_pack` downloads work in the wild. Ship `peon.zip` as a flat zip with these 6 mp3 files (names must match `soundpacks.rs` catalog): `work-work.mp3`, `ready.mp3`, `yes.mp3`, `pissed.mp3`, `not-that-kind.mp3`, `complete.mp3`. Additional peasant/acolyte/wisp packs can follow later. Audio sources: extract from your WC3 install with Ladik's MPQ Editor (see `docs/superpowers/specs/2026-04-20-per-project-notifications-and-sound-packs-design.md`) or grab from `github.com/WarRaft/War3.mpq` / `github.com/PeonPing/og-packs`.
