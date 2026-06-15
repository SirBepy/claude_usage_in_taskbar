---
id: 113
slug: remote-chat-icon-not-border
title: Remote chats - show a remote ICON, keep the real status border (don't override with blue)
status: open
---

## Why
Remote chats currently get a blanket BLUE border that OVERRIDES their real status border, so you lose the at-a-glance state (busy / question / closing / etc.) for any remote chat. Joe wants remote chats to keep their NORMAL status border and instead carry a small "remote" ICON badge indicating they're remote.

## Scope
- Find where the remote/blue border is applied to chat rows + panes (grep for the remote-state class / blue border in src/views/sessions/*.css + sidebar/active-session render).
- Remove the border override; instead render a small remote-indicator icon (Phosphor) on the row (and pane header), so remote chats keep their real status border AND show they're remote.
- Make sure it composes with the other state colors (busy/question/closing) - the icon is orthogonal to the border.

## Acceptance
- A remote chat that is busy/asking/closing shows the CORRECT status border for that state, plus a remote icon.
- No more blue-border override hiding the real state.
- Pairs with the color-system pass in ai_todo 112.
