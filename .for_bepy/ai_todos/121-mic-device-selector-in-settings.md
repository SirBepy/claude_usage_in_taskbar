# Add mic device selector to Settings > Sound

## Goal

Move the microphone input device picker (previously in the composer row) into Settings > Sound, so users can choose their mic without cluttering the chat input.

## Context

The `<select class="composer-mic-select">` was removed from the composer in commit 19e1f32 (adaptive buttons layout). The underlying logic is intact:
- `src/shared/chat/voice/voice.ts` exports `listMics()`, `getSelectedMic()`, `setSelectedMic()`
- `populateMicSelect()` in `composer.ts` is now a no-op (micSelect is null), but the preference stored by `setSelectedMic` is still read when a recording starts

Settings Sound view: `src/views/settings/subviews/sound/sound.ts`
It already has an **Audio output** subsection with a device selector. Mic input is a natural addition below it (or alongside).

## Approach

1. In `sound.ts`, add an **Audio input** subsection after the output device selector.
2. Render a `<select>` populated via `listMics()` - same logic as the old `populateMicSelect()`.
3. Wire `onchange` to `setSelectedMic()`.
4. Hide the row if fewer than 2 mics (same rule as before), or always show with "Default" as the first option - pick whichever matches the existing output-device pattern in that file.
5. No Rust changes needed; this is pure frontend.

## Acceptance

- Settings > Sound shows a mic input device picker when 2+ mics are present.
- Changing it persists (verified by re-opening Settings or starting a voice recording - it uses the chosen device).
- Composer row has no mic dropdown.
