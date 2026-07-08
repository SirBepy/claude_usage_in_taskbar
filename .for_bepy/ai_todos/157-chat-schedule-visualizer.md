# Chat Schedule Visualizer

## Goal

A dedicated view that shows all scheduled/cron chat jobs - past runs with status and transcript access, future runs grouped by time chunk - with quick actions to trigger a job now or re-run a failed one.

## Context

Joe batches heavy work in the days before his weekly token reset, so he needs to see load distribution across upcoming time chunks ("am I overloading Tuesday night?") and confidence in what already ran ("did that refactor job succeed Friday?"). The existing `/schedule` skill + CronList/CronCreate/CronDelete MCP tools are the data source. Job history is stored by the cloud agent runtime - need to grep where the daemon surfaces run records (check `src-tauri/src/` for schedule/cron-related Rust handlers and any IPC commands that fetch job history). The schedule skill already exists at `~/.claude/skills/schedule.md`; this todo is purely the in-app visualization layer.

Prime files to audit before implementing:
- `src-tauri/src/` - grep `cron`, `schedule`, `routine` for existing IPC handlers
- `src/` - grep `cron` for any existing frontend references
- Check what CronList returns (fields: id, name, next_fire, last_run, last_status, schedule expression)

## Approach

### New view: "Schedule" tab or panel

Add a "Schedule" entry to the sidebar nav (or as a subview of an existing panel - confirm placement against current nav structure before adding). Route: `schedule-view`.

### Layout: split timeline

```
[PAST RUNS]                    |  [UPCOMING]
                               |
  ✓ Refactor auth  Fri 14:00   |  Today 18:00  (2 jobs)
  ✗ DB migration   Fri 09:00   |  Tomorrow     (1 job)
  ✓ Lint sweep     Thu 22:00   |  Wed Jul 8    (4 jobs)
  ...                          |  Thu Jul 9    (0 jobs)
```

**Past runs list (left/top, reverse-chron):**
- Status icon: ✓ success / ✗ failed / ⟳ running / ? unknown
- Job name + scheduled time
- Actual run duration if available
- Click row: opens a detail panel/modal with transcript (if stored) or link to the claude.ai run log
- "Re-run" action button on failed rows

**Upcoming list (right/bottom, chron):**
- Group by day bucket, show count per bucket as a summary chip (visual load indicator - this is Joe's "how packed is Tuesday" view)
- Expand a bucket to see individual jobs
- Each job shows: name, scheduled time, cron expression
- "Run Now" action button per job
- "Delete" action (with confirmation) per job

### Data fetching

Invoke CronList IPC on mount + poll every 60s. For past-run history: check if the daemon exposes a `list_run_history` or similar; if not, this is a Phase 2 item and the past-runs panel shows a "Run history not yet available" placeholder rather than being skipped entirely.

### Actions

- **Run Now**: invoke the trigger-job IPC immediately, optimistically mark as "running", refresh after 2s
- **Re-run**: same as Run Now but on a previously-failed job row
- **Delete**: invoke CronDelete, remove from list with confirmation toast
- **New job**: "+ Schedule" button opens the existing schedule flow (or links to `/schedule` skill invocation in a chat)

### Token estimation (deferred, not in this todo)

Joe acknowledged this is probably unrealistic for now. Note it here for future reference: could estimate based on historical runs of same job type × remaining weekly budget. Skip for this implementation.

## Acceptance

- Schedule view is reachable from the main nav without a reload.
- CronList data renders correctly: future jobs grouped by day, count per bucket visible at a glance.
- Past runs show at minimum name + time + status (✓/✗); detail/transcript is a bonus if the IPC supports it.
- "Run Now" triggers the job and provides feedback (toast or status update).
- "Re-run" works on failed rows.
- View does not break if CronList returns empty or if run-history IPC is unavailable (graceful empty states).
- No regression to existing sidebar nav items or cron-related flows.
- Verify: open the view, confirm a known upcoming job appears with correct next-fire time matching CronList output.
