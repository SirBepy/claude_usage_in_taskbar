# Live-verify the standardized statusline chip popovers

**Type:** task

## Goal
Drive the running app and confirm the standardized chip-popover behavior actually renders correctly, since the change (commit `a000d6fe`) was only typecheck-verified, not visually verified.

## Context
All seven statusline-chip popovers were unified onto a shared `PopoverShell`
(`src/views/sessions/statusbar-popover-shell.ts`) with one placement contract:
open directly BELOW the chip, CENTERED on it horizontally, clamped back inside
the window on either edge, and height-capped to the remaining window so tall
content scrolls inside the shell.

The three previously-inline popovers (Effort, Model, AI Todos) were converted
from CSS-positioned inline HTML (they used to open ABOVE the bar, anchored to bar
corners) to body-appended shells - this is the highest-risk part to eyeball.

A dev rebuild bounces live chats (`project_dev_rebuild_bounces_chats`), so this
was deferred rather than run mid-session.

## Approach
Bring the app up via `/supervised-run` (`cargo tauri dev`). In an active chat's
statusbar, click each chip that has a popover and verify:
- **Effort** (slider), **Model**, **AI Todos**, **Drain**, **Branch**,
  **Commits**, and a **tool-tally** chip.
- Each opens BELOW its chip, centered, and never spills off the window edge
  (test with a chip near the right edge - narrow the window / scroll the row).
- Tall ones (drain rundown, branch list, commits, todos, tool targets) SCROLL
  inside the shell rather than overflowing.
- Only ONE popover is open at a time (opening any closes the others - this is a
  deliberate behavior change; confirm Joe is happy with it).
- Effort slider still persists the chosen effort and closes on change.

## Acceptance
Every chip popover opens below+centered+clamped, tall content scrolls, and
one-at-a-time dismissal works. Capture a screenshot of an open popover (e.g.
drain) to `.for_bepy/screenshots/` for the record.
