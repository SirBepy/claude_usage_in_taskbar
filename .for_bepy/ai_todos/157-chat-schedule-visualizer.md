# Cloud cron jobs in the Schedule view

Type: feature

## Goal

Surface Anthropic's cloud cron jobs (the `/schedule` skill's CronList/CronCreate/CronDelete routines) in the app's Schedule view, replacing the current "No data path to claude.ai cron jobs yet" placeholder section.

## Context (re-scoped 2026-07-09)

The original todo (a full schedule visualizer) shipped as the in-app scheduling feature: Schedule nav view with upcoming-by-day agenda, missed/failed handling, in-app scheduled messages/chats, and read-only Windows Task Scheduler rows (`schedule_list_external` reading `%LOCALAPPDATA%\ClaudeScheduleOnce\jobs` sidecars). See `src/views/schedule/schedule.ts` and `src-tauri/src/ipc/schedule.rs`.

What remains is ONLY the cloud-cron leg, and it is blocked on a data path: CronList/CronCreate/CronDelete are MCP tools available inside Claude Code sessions, not an API the app can call. Verified 2026-07-09: no IPC or endpoint for them exists anywhere in the codebase.

## Approach (when unblocked)

1. First find a data path: either an HTTPS endpoint on claude.ai the usage-cookie auth can reach (investigate what the CronList tool hits), or drive a headless `claude -p` that calls CronList and parses the result (expensive, last resort).
2. Then: new IPC `schedule_list_cloud` returning rows shaped like `ExternalScheduledJob`, merged into the existing "Cloud cron jobs" section of the Schedule view (currently renders the honest empty state).
3. Past-run history and Run Now/Re-run actions from the original spec apply here if the data path supports them.

## Acceptance

- Cloud cron jobs render in the Schedule view's cloud section with name + next fire time.
- View still degrades gracefully (placeholder) when the data path is unavailable.
