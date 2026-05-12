# Scope commit to session-touched files only

## Goal
When the chat close flow commits via `/close /commit`, only stage files that were modified during this session, not files that were already dirty before the session started.

## Context
`active-session.ts` captures `baselineDirtyFiles` at session open (via `get_git_dirty`). At close time it computes `newDirty = currentDirty.filter(f => !baselineDirtyFiles.includes(f))` to decide whether to show the commit modal. However, when `/close /commit` actually runs inside the chat, the `/commit` skill stages everything modified - it has no awareness of which files belong to this session. If another Claude session was running concurrently and modified different files, those get swept into the commit too.

## Approach
Pass `newDirty` (the session-scoped file list) into the chat message instead of bare `/close /commit`. Options:
- Send `/close /commit -- file1 file2 file3` and update the `/commit` skill to accept an explicit file list when `--` is present.
- Or: stage only `newDirty` files via a pre-commit IPC command before sending `/close /commit --skip-stage` (requires a new `stage_files` IPC).

The `/commit` skill approach is simpler since it avoids a new IPC. The skill already does `git add <files>` by name; the caller just needs to pass the list.

## Acceptance
- Two concurrent sessions each modify different files
- Closing session A commits only A's files; B's files remain unstaged
- Closing session B then commits B's files cleanly
