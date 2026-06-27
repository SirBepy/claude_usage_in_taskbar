# Session context menu rework

## Goal

Rework the session ⋮ context menu into 4 named submenus + Close session, and **merge it into the top-right view ⋮** (`viewMoreBtn`) as a context-aware section. The standalone chat-pane-header ⋮ (`more-btn` in `session-header.ts`) is **removed** - it always sat right under the view ⋮ and Joe never wanted two ⋮ stacked. Reuse the same 4-submenu block for sidebar session rows and draft sessions (with disabled states for draft).

## Context

Current state - TWO ⋮ buttons, different scopes, stacked top-right:
- `viewMoreBtn` (view-header, top-right of screen): Sort / New chat / History / Sleep-when-done / Shutdown-when-done.
- `more-btn` (chat-pane header, `session-header.ts`): Auto-accept / Change character / Move to terminal / Open directory ▶ / Detach / Close session.

### Merged top-right ⋮ structure - **Variant B (globals-on-top), label "General"**

Context-aware. When a chat is open:

```
  GENERAL  (greyed section label)
    New chat
    History
    When done ▶        Sleep when done / Shutdown when done
  ─────────────────────
  THIS CHAT  (greyed section label)
    Open project in ▶  VS Code / Terminal / File Explorer / Dashboard
    Chat ▶             Hide / Move to terminal / View changes
    Configure ▶        Auto-accept / Change character
    Agent ▶            New chat here / Copy PID / Detach
    Close session
```

When **no chat focused** (list view, or mobile sidebar showing): the "This chat" block + its divider vanish; menu is just the GENERAL section.

Decisions locked (preview-reviewed `C:\tmp\menu-preview.html`):
- **Order:** globals on top (Variant B) - top rows never shift as you move between chats; the chat block appends below.
- **Section labels:** "General" for globals, "This chat" for the focused-session block. Both greyed `sect-label` style.
- **Sort:** removed from the menu, moved to Settings (keeps the rarely-used recent/name/drain options without cluttering here; status stays the default).
- **New chat:** kept in GENERAL. Do NOT drop it for the FAB - the FAB lives in the sidebar, which `sessions.css:1287` hides in mobile chat mode, so the top ⋮ is the only new-chat affordance on mobile-in-chat.
- **When done ▶:** Sleep / Shutdown move into a submenu; when armed, the parent row shows the amber countdown inline (e.g. "Sleep in 42s") + the corner ⋮ keeps its amber indicator dot. Replaces the old flat toggles + chip.
- The 4 chat submenus stay inlined under the "This chat" label (NOT wrapped in a single "This chat ▶") so depth stays 2 clicks and it mirrors the sidebar card menu 1:1.

Everything except Close session and the GENERAL leaf items is 2 clicks deep.

Changes from current:
- "Open directory" → "Open project in"; add Dashboard as 4th submenu item
- New submenu "Chat ▶": Hide chat + Move to terminal (relocated from top level) + View changes (relocated from toolbar)
- New submenu "Configure ▶": Auto-accept + Change character (both relocated from top level)
- "Agent ▶" replaces old ad-hoc items: New chat here (new) + Copy PID (new) + Detach (relocated)
- Close session stays as sole top-level action at the bottom

## Approach

Key files: `more-menu.ts` (per-session menu, to be removed/repurposed), `view-more-menu.ts` (top-right ⋮, gains the "This chat" section), `session-header.ts` (drop the `more-btn` + changes-btn), `template.ts` (`#view-more-host`), `sidebar.ts` (row ⋮ / right-click).

1. **Build the 4-submenu chat block as a reusable component** (from current `more-menu.ts`), so the same markup feeds: the view ⋮ "This chat" section, the sidebar row menu, and draft state.
2. **Merge into `view-more-menu.ts` (Variant B):** GENERAL section (New chat / History / When done ▶) on top, separator, then the "This chat" block - rendered only when a chat is focused. Note the existing live-node relocation trick (it moves `#newSessionBtn` etc. in/out to keep listeners) - the chat block should mount into a dedicated slot rather than fight that.
3. **Remove the chat-pane-header ⋮:** delete `more-btn` wiring in `session-header.ts`; keep avatar-click → change character (the one contextual action that stays on-object).
4. **Sort → Settings:** remove the sort `<select>` from the menu; surface it as a Settings preference (status default).
5. **When done ▶:** wrap the two `data-when-done` toggles in a submenu; show the armed countdown on the parent row (reuse `whenDoneMenuHtml` / the chip text), keep the `has-indicator` amber dot on `viewMoreBtn`.
6. **Open project in ▶:** existing VS Code / Terminal / File Explorer entries stay; add "Dashboard" entry that navigates/focuses the Dashboard view filtered to this session.
7. **Chat ▶ - Hide chat:** check if hide logic already exists; if not, hide/collapse the chat panel.
8. **Chat ▶ - View changes:** remove the toolbar `changes-btn` in `session-header.ts`; only expose it here.
9. **Agent ▶ - New chat here:** spawn a new agent in the same project directory. **Copy PID:** copy the agent process PID to clipboard.

**Sidebar reuse:** wire the same chat-block component to the sidebar session row ⋮ or right-click. Session context object is the same, no data changes needed. This is the primary way to act on a chat you are NOT currently viewing.

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

- Only ONE ⋮ remains (top-right `viewMoreBtn`); the chat-pane-header ⋮ is gone.
- Top ⋮ matches Variant B: GENERAL (New chat / History / When done ▶) on top, separator, then "This chat" (4 submenus + Close) - in that order, with both greyed section labels.
- "This chat" block is shown only when a chat is focused; hidden in list/mobile-sidebar view.
- New chat is reachable from the top ⋮ on mobile while in a chat (FAB is hidden there).
- Sort removed from the menu; available in Settings; status remains default.
- When done ▶ submenu works; armed state shows the countdown on the parent row + amber dot on `viewMoreBtn`.
- Dashboard entry in Open project in ▶ works.
- View changes removed from the chat-pane toolbar; only accessible via Chat ▶.
- Auto-accept dot indicator visible from inside Configure ▶.
- Sidebar session row shows the same 4-submenu chat block (right-click + row ⋮).
- Draft: disabled items show tooltip on hover; Close session reads "Delete draft".
- No regressions on existing Open in VS Code / Terminal / File Explorer actions.
