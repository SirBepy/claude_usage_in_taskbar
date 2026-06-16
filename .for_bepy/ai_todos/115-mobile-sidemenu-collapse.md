---
id: 115
slug: mobile-sidemenu-collapse
title: Mobile layout - sidemenu collapses to overlay on narrow screens
status: open
---

## Problem

On the phone browser (remote cockpit), the sidemenu and the sessions chat pane render side-by-side at full width. On a phone screen both are too cramped to use. User should see either the sidemenu OR the chat, not both squeezed together.

## Desired behaviour

- Narrow viewport (mobile, ≤ ~768px): sidemenu is hidden by default; a hamburger/back button reveals it as a full-width overlay. Tapping a session in the sidemenu auto-closes it and shows the chat pane.
- Wide viewport (desktop webview, tablet+): unchanged - sidemenu always visible.
- The existing `openSidemenu` / `closeSidemenu` helpers + `#sidemenuBackdrop` already exist for the mobile sidemenu on the dashboard view; the sessions view may need the same treatment wired up.

## Acceptance

- On a phone browser at `#sessions`, only the chat pane (or only the session list) is visible at a time.
- Tapping a session in the sidemenu navigates to that session's chat and collapses the sidemenu.
- Desktop webview is pixel-unchanged.
- No regressions in the existing sidemenu open/close on dashboard.
