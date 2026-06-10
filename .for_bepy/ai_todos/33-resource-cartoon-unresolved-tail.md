# HotS unresolved-clip tail + optional full-roster re-pull from CASC

## Goal
Close out the few still-cropped HotS clips, and (optionally) re-pull the whole HotS roster from the authoritative local game CASC so every hero is complete - not just the ~15-clip jamiephan subset.

## Context
The 2026-06-06 autopilot re-source fixed 1054/1136 clips. **Cartoons (family-guy 43, simpsons 28 unresolved) are NO LONGER IN SCOPE - the Family Guy / SpongeBob / Simpsons characters were deleted 2026-06-06** (mislabeled + low-bitrate soundboard audio, no clean source; see BEPY_TODOS revisit note). Murky / Sgt Hammer (`SiegeTank`) / Gall were rebuilt full from the CASC the same day.

What actually remains unresolved:
- **HotS 7 `laugh` clips** (anub-arak/azmodan/chen/kharazim/mephisto/rehgar/rexxar): jamiephan + Fandom lacked Laugh VO, so they're still old 2s crops. BUT storm-extract is now built and the `enus` CASC DOES carry `Laugh` tokens per hero (confirmed: gall had 10, murky had them) - so these are very likely fixable now via CASC, unlike when 33 was first written.
- **army-men 4** (hoover-attacked-1, hoover-move-1/2, shrap-spotted-1): the PC release of Army Men RTS ships NO hero-unit voice audio (verified by carving every NORK `.x` archive); only cinematic briefing MP3s exist. Genuinely unsourceable - accept as-is.

## Approach
storm-extract is built at `~/storm-extract/build/bin/storm-extract` in WSL (Ubuntu); deps installed. Install path `/mnt/c/Program Files (x86)/Heroes of the Storm`. VO lives at `mods/heroes.stormmod/enus.stormassets/LocalizedData/Sounds/VO/<HeroInternalName>_<Action>NN.ogg`. Hero internal names are NOT always the display slug (Sgt Hammer = `SiegeTank`, Gall = `GallBase`, Murky = `Murky`) - list prefixes first.

1. **7 laughs**: extract `<HeroName>_Laugh*` from enus for the 7 heroes, replace the cropped `*-laugh-*.ogg` in place (same filename). Use the slug->internal-name map (search prefixes per the method in this session's transcript).
2. **Optional full re-pull (Joe's call - offered, not yet taken)**: re-extract the entire 90-hero roster from `enus` so each hero has its complete kit instead of the ~15-clip jamiephan subset. Curate ~16-20 per hero into the 6 slots + pool (classifier: Pissed->annoyed, IntroQuestion->question_asked, IntroRespond/IntroBoast->ready, AI_GoodJob->work_finished, Yes/Attack->select, VOX_GetHit->death), apply length rules (<=5s whole, 5-10s park to COMMENTS pending approval, >10s skip), codec must be vorbis.
3. army-men 4: accept unsourceable; note and drop from the unresolved list.

Always prefer game files (see memory [[feedback_prefer_local_game_files]]); verify each write landed via mtime+duration, don't trust self-reports. Data is outside the repo.

## Acceptance
- The 7 HotS laughs either re-sourced full from CASC (verified by duration != ~2.0s) or confirmed unavailable in enus.
- army-men 4 explicitly accepted as unsourceable.
- If Joe opts into the full re-pull: every hero >= the prior clip count, all vorbis, no duplicate game dirs (see the canonical-game-dir rule now in the character-creator skill).
