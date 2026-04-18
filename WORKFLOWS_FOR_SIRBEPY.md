# Manual tasks for Joe

Numbered steps Joe needs to do by hand that can't be automated.

1. Generate the Tauri updater signing keypair (one-time, pre-release):

       mkdir -p ~/.tauri
       ~/.cargo/bin/cargo tauri signer generate -w ~/.tauri/claude-usage.key

   Save both `~/.tauri/claude-usage.key` (private) and `~/.tauri/claude-usage.key.pub` (public) to a password manager. Never commit either to git.

   Then replace the string `REPLACE-WITH-GENERATED-PUBKEY` in `tauri/tauri.conf.json` with the contents of `~/.tauri/claude-usage.key.pub`.
