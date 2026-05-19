# Extract shared subview header component for project detail views

## Goal

Replace the duplicated avatar+title header pattern across `session-detail.ts` and `sessions-list.ts` with a single shared component, so back-button behavior and right-side menu items can be passed in as props.

## Context

Both `session-detail.ts` (line ~204) and `sessions-list.ts` (line ~90) render nearly identical headers:
- Back button (left)
- `avatar-mini` + `project-detail-titles` (center)
- Spacer or menu anchor (right)

Today's session removed the path div from both but left the duplication in place. The title differs: `sessions-list` shows the project name; `session-detail` shows the session name/ID. A shared header component would need to accept: back handler, title string, optional right-side element (menu or spacer).

There's also a `populateProjectSubviewHeader(prefix)` helper in `sessions-list.ts` that populates avatar+title by ID prefix. It could become the data layer for a shared template.

## Approach

1. Create `src/views/project-detail/subview-header.ts` with a `renderSubviewHeader({ title, avatar, onBack, menuItems? })` function that returns a lit-html template fragment.
2. Replace both `session-detail.ts` template header and `sessions-list.ts` template header with calls to `renderSubviewHeader`.
3. Wire `onBack` to `backFromSubview()` (both views use this).
4. Wire `menuItems` to the 3-dot menu items in project-detail if desired; pass `undefined` for session-detail and sessions-list (they have no menu).
5. Remove `populateProjectSubviewHeader` if it can be fully replaced.

## Acceptance

- Both session-detail and sessions-list header render identically to before (avatar, title, back button).
- No `.project-detail-path` divs remain.
- The header template lives in one place; adding a field only requires touching `subview-header.ts`.
- Cargo + vitest pass.
