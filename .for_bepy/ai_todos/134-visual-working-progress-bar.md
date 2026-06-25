---
id: 134
title: Visual working progress bar - app-wide AI activity indicator
priority: medium
area: frontend
---

## What

Add a visible progress bar / activity indicator to the app that updates in real time as the AI is working. The goal is to make "AI is doing something right now" feel viscerally obvious rather than inferred from text status chips.

## Behavior spec

- **Active**: when any session is in the `working` or `waiting` state (has an active turn in progress), the bar should animate - a looping indeterminate sweep or a pulse, not a fake % counter
- **Idle**: bar collapses / fades to 0 when no session is active
- **Multi-session**: if multiple sessions are running simultaneously, the bar should stay active until ALL are done
- **Placement**: top of the main window, full width, under the title bar / above the main content area; thin (3-4px), not obtrusive
- **Color**: use the existing kit accent color (`--color-accent` or equivalent); consider per-session color coding if multiple sessions are active at once

## Data sources already available

- Session `status` field already tracks working/waiting/done via the `<cc-status:..>` marker + `i.awaiting` backend
- `questionSessions` set in the frontend already knows which sessions are awaiting user input
- The `active-session.ts` component already receives live turn events

## Implementation sketch

1. Add a `workingSessionCount` reactive signal in `sessions.ts` (or wherever global session state lives) that counts sessions currently in working/waiting state
2. In the main shell (`index.html` or the Lit root), bind a `<div class="progress-bar">` whose `data-active` attribute flips based on that count
3. CSS: `@keyframes` sweep for the indeterminate animation; `transition: opacity 0.3s` for show/hide; height 3px
4. No new IPC needed - all state is already on the frontend

## Success criteria

- Bar is visible and animating within one render frame of a session starting a turn
- Bar disappears within one render frame of the last active session finishing
- Bar survives a session being closed mid-turn (count decrements correctly)
- No flicker when multiple sessions start/finish in rapid succession
