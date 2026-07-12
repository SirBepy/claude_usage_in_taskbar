# Live-verify the v0.2.14 settings rewrite (visual pass, all pages)

**Type:** task

## Goal

Eyes-on verification of the restructured Settings shipped in v0.2.14: every page renders, saves, and looks right in the running app. This is the one thing the rewrite session could not do (launching a dev instance risked bouncing Joe's live daemon).

## Context

2026-07-10 rewrite merged 12 subviews into 10 routes (see memory `settings-rewrite-v0214` and commits e365bee6..41e5fd9e on master). Logic-verified only: tsc, 583 vitest, 90 kit tests, cargo build, adversarial review (zero lost settings keys). Never run visually. Two behavior changes deserve special attention: Chat defaults now autosaves per change (Save button removed), and Launch-at-Login now writes the typed `autostart` field. The lit select-in-repeated-template bug only manifests in PRODUCTION builds - the dev-mode run is not sufficient proof for the select-heavy sections (System data cards, Chat defaults preset rows, Appearance color rows); verify on the installed 0.2.14 build or a `--release` run if possible.

## Approach

1. With Joe's go-ahead (relaunch bounces daemon/chats), run the installed v0.2.14 or `cargo tauri dev`.
2. Click through: root (4 groups, 10 iconed rows), Appearance (theme switch, palette cards, color mode swap threshold<->pace, threshold row add/remove, opacity slider), Notifications & Sound (mute-all dims children, per-type cards, ph-play previews, device pickers, character slot toggles), Characters, Chat defaults (sort select fires cc-sort-changed, preset row edits autosave, models edit re-renders preset selects), Permissions (rule remove), Statusline (dnd), Claude accounts (open+cancel add-wizard, edit modal appearance tab), Remote access, System (launch-at-login flips `autostart` in settings.json, shortcut rebind, retention select + Clear all), About.
3. Burst-capture screenshots per the transient-visual-verify rule; save keepers for Joe to `.for_bepy/screenshots/`.
4. Phone: hardware-back closes add-wizard (confirm-before-abandon past step 1) and edit modal.

## Acceptance

- Every page screenshotted; every select renders options (the production lit bug did not resurface).
- Flipped toggle values appear in `%APPDATA%\claude-conductor\settings.json` (autostart key specifically).
- No console errors on any settings page.
- Wizard opens, cancels, and hardware-back behaves; no regression in the login flow.
