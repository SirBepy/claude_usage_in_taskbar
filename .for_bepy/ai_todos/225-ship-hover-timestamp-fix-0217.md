# Ship the hover-timestamp fix as 0.2.17

**Type:** task

## Goal
Push the already-committed per-message hover-timestamp fix to master as a release, after a live relaunch confirms the tooltip actually appears on hover.

## Context
Commit `ef5324ac` ("FIX: restore per-message hover timestamps (parse RFC3339
transcript ts)") is committed locally but NOT pushed. It fixes the backend
parser so history events carry a real epoch (the transcript stores `timestamp`
as an RFC3339 string that `.as_i64()` was dropping to 0), plus a display-only
frontend fallback in `chat-dom-renderer.ts` so live ts=0 messages label with
render time.

Held back because:
- It's a backend change that needs a live relaunch to eyeball the actual
  hover UI (parser logic is unit-tested, but the tooltip wasn't visually driven).
- The 0.2.16 CI build (the NoDefault fix) was in flight at commit time; it has
  since gone green.

## Approach
1. `cargo tauri dev`, open a chat with history, hover several messages - confirm
   the time tooltip shows on user, assistant, and tool rows (real send-times for
   history, ~arrival time for a freshly-streamed live reply).
2. If good: `/commit pushnbump` (bumps package.json to 0.2.17, pushes, CI builds).
3. Release-tag-skip trap: 0.2.16 is already tagged/green, so a plain bump to
   0.2.17 is clean - no orphan-tag concern here.

## Acceptance
- Hover tooltip shows a sensible send-time on every message kind in a live app.
- 0.2.17 pushed and its Tauri Release run is green.
