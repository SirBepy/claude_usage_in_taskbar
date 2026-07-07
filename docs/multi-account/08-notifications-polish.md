# Milestone 08 - Per-account notifications, migration, tests, README

Depends on: all prior. See `00-overview.md`.

## Goal
Make usage-threshold notifications account-aware, guarantee a lossless single->multi migration, and
land the test + docs floor.

## Context
- `notifications.thresholdCrossed` (`{enabled,mode,soundFile,voiceName,template}`,
  `settings-save.ts:26-29`) fires on the shared 5h/7d %; template supports `{percent}`
  (`threshold.rs:141-169`). Global mutes gate it (`muteAll`/`muteSounds`/`pauseInMeeting`/slots).
- Test harnesses: daemon e2e + WebdriverIO (`feedback_use_existing_test_harness_before_manual`,
  `feedback_ui_bug_regression_drives_ui`).
- README rule: keep in sync when auth/tray/scraping/structure change.

## Approach
1. `thresholdCrossed` fires per account; add an `{account}` token to the template so "Work hit 80%"
   is distinguishable. Global mutes still apply.
2. Migration module: no auto-created account (accounts only exist via the 01 wizard - `/login`
   cannot be done for the user). Instead: the legacy `session.txt` poll keeps working until the
   first account is added; when an added account's `org_uuid` matches the legacy scrape org, its
   usage history + capacity re-key to it and `session.txt` retires. First app launch after
   upgrade surfaces a one-time "set up your accounts" prompt pointing at the wizard. Verified
   idempotent + lossless. Ties together the migration hooks left in 01 + 03.
3. Tests: daemon e2e for per-account spawn (02) + per-account usage (03); WebdriverIO for the
   dashboard account selector (05), the new-chat account picker (04), and the overlay (06). Follow
   `cargo test --lib` scoping caveat (`project_cargo_test_kills_daemon`).
4. Docs: README update (multi-account auth flow, tray overlay, per-account scraping); regen
   `ipc.generated.ts` (`cargo test --test export_types`).

## Files
- notification/threshold path, new migration module, tests, `README.md`

## Acceptance
- A threshold alert names its account; global mutes still gate all events.
- Migration is lossless and idempotent (existing user upgrades with no data loss; legacy scraping
  works until the wizard runs; history re-keys on `org_uuid` match).
- Fast checks pass: `cargo build --manifest-path src-tauri/Cargo.toml`, `pnpm tsc --noEmit`, unit +
  e2e; README reflects multi-account.
