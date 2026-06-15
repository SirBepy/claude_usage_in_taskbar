# Extend project tech-logos to the secondary avatar render sites

## Goal
Apply the ai_todo 99 tech-logo project face (real icon file -> Devicon stack logo -> generic folder) to the avatar sites that were left on the old "?" / first-letter placeholder, so a project's face is consistent everywhere.

## Context
ai_todo 99 (shipped, commit 82b29d7) added `renderAvatar(avatar, projectPath?)` + `hydrateProjectTechIcons(host)` in `src/shared/projects.ts`, wired into the projects LIST (`src/views/projects/projects.ts`) and the project-detail HEADER (`src/views/project-detail/project-detail.ts`). The no-user-avatar path renders `<span class="proj-face" data-proj-face="<path>">` which `hydrateProjectTechIcons` fills via the `get_project_icon` / `get_project_tech` IPC.

These sites still call `renderAvatar(avatar)` WITHOUT a path, so they keep showing the bare placeholder for projects with no custom avatar:
- `src/views/project-detail/subview-header.ts` (uses `unsafeHTML(renderAvatar(avatar))` in a lit template - hydration is trickier here; lit re-renders).
- `src/views/session-detail/session-detail.ts:~250` (also `unsafeHTML(renderAvatar(avatar))`).
- `src/views/project-detail/subviews/character-pick/character-pick.ts` (only hydrates when `avatar.kind === "character"`).

## Approach
1. Thread the project path (cwd) into each site's `renderAvatar(avatar, cwd)` call.
2. After the DOM is in place, call `hydrateProjectTechIcons(host)` (alongside the existing `hydrateCharacterAvatars`).
3. For the lit `unsafeHTML` sites: the placeholder string renders fine, but lit may re-render and wipe the hydrated content. Hydrate after the lit render settles (mirror how `hydrateCharacterAvatars` is already invoked there), or confirm the existing char-avatar hydration pattern at that site survives re-render and reuse it.
4. Decision Joe parked (see COMMENTS_FOR_BEPY 2026-06-15): it may be fine to leave these as-is. If a site's avatar is too small or the path isn't readily available, leave it on the placeholder and note why rather than forcing it.

## Acceptance
- Projects with no custom emoji/image/character avatar show their tech logo in the targeted secondary sites too (or a documented note explaining which sites were intentionally left).
- Custom emoji/image/character avatars unchanged everywhere.
- `pnpm tsc --noEmit` clean (modulo the pre-existing vendor `stack.ts` error), `pnpm vitest run` green.
