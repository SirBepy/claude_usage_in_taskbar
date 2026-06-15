# Character slot sound: remaining triggers + per-slot settings toggles

## Goal
1. Play `ready` + `select` sounds when a new chat is created.
2. Play `death` sound when a chat is closed.
3. Add a global per-slot on/off toggle in Settings so each slot (work_finished, question_asked, select, ready, death, annoyed) can be independently muted.
4. Add an optional "play `select` on session click" toggle (off by default - Joe said it's "retarded" but wants the knob).

## Context
Joe's explicit spec from session 2026-06-15:
- New chat creation: play Select + Ready sounds
- Work finished: already handled by daemon-link (notifications::rules::fire)
- Question asked: already handled by daemon-link
- Annoyed: skip for now (no trigger needed)
- Death: play when closing a chat
- All slots: globally toggleable in Settings

Current frontend slot triggers (after 93e6f29):
- `select`: only fires in `changeCharacterForSession` (character swap) and `model-effort-modal.ts` (character preview during session start)
- `ready`: no trigger exists yet
- `death`: no trigger exists yet

The `play_character_slot` IPC command (`src-tauri/src/ipc/characters.rs`) already checks `mute_all()` / `mute_sounds()`. Per-slot toggles need new settings fields.

**IMPORTANT**: work_finished and question_asked must NOT be added to the frontend path - the daemon-link already fires them. See memory `project-character-sound-architecture`.

## Approach

### New triggers
- `ready`: fire from `pending-flow.ts` (or wherever `ensure_session_character` is called after a new session is live) - use `api.playCharacterSlot(charId, "ready")`
- `select` on new session: fire alongside `ready` at the same point (same event, different slot)
- `death`: fire from `close-chat.ts` (or the close handler in sessions.ts/active-session.ts) - just before or after the session is torn down

### Per-slot settings
Add settings fields (e.g. `characterSoundSlots: { work_finished: bool, question_asked: bool, select: bool, ready: bool, death: bool, select_on_click: bool }` or individual `boolean` extra-settings keys) in `src/views/settings/` Sound subview.

In `play_character_slot` Rust command, read the per-slot enabled state before playing (similar to the existing `mute_all()` / `mute_sounds()` check).

For work_finished/question_asked the daemon-link path must also check the setting - add a read of the same key in `notifications::rules::fire()` or `resolve_with_character()`.

### "Select on session click" toggle
When enabled, fire `api.playCharacterSlot(charId, "select")` at the top of `selectSession()` in `active-session.ts` (after finding the character, before rendering). Default: off.

## Acceptance
- Clicking "New Chat" plays a sound (ready and/or select, whichever slots have files for the assigned character).
- Closing a chat (X button or close command) plays the death sound if the character has one.
- Settings > Sound shows toggles for each slot; toggling one off stops that slot from playing.
- "Select on session click" toggle works when enabled.
- Mute Notifications (tray) still overrides all of the above.
- No double-play for work_finished/question_asked.
