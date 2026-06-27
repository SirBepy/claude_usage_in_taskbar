# Session context menu rework

## Goal

Rework the session ⋮ context menu into 4 named submenus + Close session. Reuse the same menu for sidebar session rows and draft sessions (with disabled states for draft).

## Context

Current menu (chat header ⋮):
- Auto-accept (toggle)
- Change character
- Move Session to Terminal
- Open directory ▶ (VS Code / Terminal / File Explorer)
- Detach
- Close session

Agreed final structure:

```
  Open project in ▶    VS Code / Terminal / File Explorer / Dashboard
  Chat ▶               Hide / Move to terminal / View changes
  Configure ▶          Auto-accept / Change character
  Agent ▶              New chat here / Copy PID / Detach
  ─────────────────────
  Close session
```

Everything except Close session is 2 clicks deep. No top-level items besides the 4 submenus.

Changes from current:
- "Open directory" → "Open project in"; add Dashboard as 4th submenu item
- New submenu "Chat ▶": Hide chat + Move to terminal (relocated from top level) + View changes (relocated from toolbar)
- New submenu "Configure ▶": Auto-accept + Change character (both relocated from top level)
- "Agent ▶" replaces old ad-hoc items: New chat here (new) + Copy PID (new) + Detach (relocated)
- Close session stays as sole top-level action at the bottom

## Approach

1. Find the menu component - search src/ for "Close session" and "Move Session to Terminal".
2. Restructure items to match the 4-submenu layout above.
3. **Open project in ▶:** existing VS Code / Terminal / File Explorer entries stay as-is; add "Dashboard" entry that navigates/focuses the Dashboard view filtered to this session.
4. **Chat ▶ - Hide chat:** check if hide logic already exists; if not, hide/collapse the chat panel.
5. **Chat ▶ - View changes:** remove it from wherever it currently lives in the toolbar/main UI; only expose it here.
6. **Agent ▶ - New chat here:** spawn a new agent in the same project directory.
7. **Agent ▶ - Copy PID:** copy the agent process PID to clipboard.

**Sidebar reuse:** wire the same menu component to the sidebar session row ⋮ or right-click. Session context object is the same, no data changes needed.

**Draft session state:** same menu, disable anything that needs a live process:

| Item | Draft |
|---|---|
| Open project in ▶ (all) | enabled |
| Chat - Hide chat | enabled |
| Chat - Move to terminal | disabled - "No active agent" |
| Chat - View changes | disabled - "No active agent" |
| Configure - Auto-accept | enabled (pre-config) |
| Configure - Change character | enabled (pre-config) |
| Agent - New chat here | disabled - "Start a chat first" |
| Agent - Copy PID | disabled - "No active agent" |
| Agent - Detach | disabled - "No active agent" |
| Close session | rename to "Delete draft" |

## Acceptance

- Menu matches the 4-submenu structure exactly (labels, grouping, order).
- No top-level items except the 4 submenus + Close session divider.
- Dashboard entry in Open project in ▶ works.
- View changes removed from toolbar; only accessible via Chat ▶.
- Auto-accept dot indicator visible from inside Configure ▶.
- Sidebar session row shows the same menu.
- Draft: disabled items show tooltip on hover; Close session reads "Delete draft".
- No regressions on existing Open in VS Code / Terminal / File Explorer actions.
