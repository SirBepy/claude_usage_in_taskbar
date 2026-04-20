# Manual tasks for Joe

Numbered steps Joe needs to do by hand that can't be automated.

1. Generate the Tauri updater signing keypair (one-time, pre-release):

       mkdir -p ~/.tauri
       ~/.cargo/bin/cargo tauri signer generate -w ~/.tauri/claude-usage.key

   Save both `~/.tauri/claude-usage.key` (private) and `~/.tauri/claude-usage.key.pub` (public) to a password manager. Never commit either to git.

   Then replace the string `REPLACE-WITH-GENERATED-PUBKEY` in `tauri/tauri.conf.json` with the contents of `~/.tauri/claude-usage.key.pub`.

2. Add GitHub repo secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` with the values generated in step 1. Go to `https://github.com/SirBepy/claude_usage_in_taskbar/settings/secrets/actions`.

3. To cut a Tauri pre-release:

       git tag tauri-v0.1.0
       git push origin tauri-v0.1.0

   Watch the Actions tab for build progress. The release lands in the Drafts tab - promote it manually after smoke-testing the installer.

4. Place Piper binaries in `tauri/binaries/piper/`: `piper.exe` (Windows), `piper` (mac/linux). Download from https://github.com/rhasspy/piper/releases. Required for high-quality notification voices.

5. Visual check of the new tray font (Task 7 of `docs/superpowers/plans/2026-04-20-tray-font-swap.md`):

       cd tauri
       npm run tauri dev

   Then:
   - Click the tray icon to cycle icon → session number → weekly number.
   - Confirm Inter SemiBold reads cleanly at 22x22 in the Windows tray.
   - Confirm 1, 2, and 3-digit values all fit (e.g. 0, 45, 100).
   - Confirm the spin animation on manual poll still renders.
   - Open Settings → Icon section: the "Number Font Style" dropdown must be gone; Icon Style is still there.

   Known quirk to watch for: `measure_text` centers on ink bounds, not advance width — single-digit values may sit 1-2 px off visual center. If visible, switch `measure_text` in `tauri/src/fonts.rs` to return advance width (`pen_x.ceil() as u32`) instead of `max_x - min_x`, then retune `overlay_size_px` in `tauri/src/icon.rs`.
