# Optional: blurred backdrop behind the chat-header avatar circle

## Goal

Apply the same blurred-backdrop hexagon-hiding trick the sidebar uses to the open-chat header avatar circle, so any transparent (hexagonal) HotS portrait shows blurred hero colours at the circle's edges instead of a faint backdrop sliver.

## Context

- Sidebar avatars already do this: `src/views/sessions/sidebar.ts` `leadingVisual` emits two layered `<img>` (`.session-char-backdrop` blurred + `.session-char-img` sharp); styled in `sessions.css` (`.session-char-backdrop` = `transform: scale(1.8); filter: blur(7px)`).
- The header avatar is a single circular `<img class="char-avatar session-header-char ...">` built in `src/views/sessions/active-session.ts` `selectSession` (and the pending header in `pending-pane.ts`). It has a status-coloured ring (added 2026-06-13) but no backdrop, so a transparent hexagon can show a faint sliver at the top/bottom of the circle.
- Deferred because Joe didn't flag it as a problem; it's a micro-polish offer, not a reported bug. Low priority. Becomes moot if ai_todo 91 (square portraits) lands - opaque squares need no backdrop.

## Approach

- Wrap the header avatar in a `.session-header-avatar` span containing a backdrop `<img class="char-avatar session-header-backdrop">` + the sharp `<img class="session-header-char">`, both with the same `data-character-id`/preload `src` so the existing `hydrateCharacterAvatars` pass fills both (it already mirrors the sidebar pattern).
- Clip to a circle on the wrapper (`border-radius: 50%; overflow: hidden`) and move the status ring to the wrapper. Keep the sharp image `object-fit: cover`.
- Mirror the change in `pending-pane.ts` if/when the pending header gains an avatar (it currently has none).

## Acceptance

- Open a chat whose hero portrait is a transparent hexagon (any HotS hero) → the circle edges show blurred hero colour, no faint backdrop sliver, status ring intact and still live-recolours.
- Must NOT regress: the live status-ring recolour (`updateHeaderAvatarStatus` in `sessions.ts`) still finds `.session-header-char`; title/meta layout unchanged.
