# Re-source the 82 unresolved cartoon/army-men/HotS clips (and looser family-guy pass)

## Goal
Replace as many of the 82 still-cropped clips as possible with full-length originals, in place, same filename. Full list: `.for_bepy/resource_unresolved.txt`. Breakdown: family-guy 43, simpsons 28, heroes-of-the-storm 7 (`laugh`), army-men-rts 4.

## Context
The 2026-06-06 autopilot re-source fixed 1054/1136 clips. The remaining 82 had no unattended source:
- **family-guy 43**: most are "Stewie Griffin: The Untold Story" DVD-only lines (anguish-sustains-me, shmootzplatzen, holy-frijole, anorexic-aliens, no-apologies, rude-service, etc.) absent from reachable soundboards; Brian's realmofdarkness board is an empty stub; some slugs are character-creator action labels, not verbatim quotes. The family-guy subagent (held a strict exact-phrase bar) offered ~6-8 MORE recoverable via LOOSER matching from realmofdarkness.net (`/audio/fg/<char>/<board>/<id>.mp3`, ids in `/scripts/sb/fg/<char>/<n>/sounds.js`): hilarious->"Clever", gorgeous->"Pretty", interview->"Be on TV", knock-it-off->"Don't". Joe wanted to decide whether to accept looser matches.
- **simpsons 28**: `bart-clip-N` (10) and `lisa-line-1` have non-descriptive filenames (nothing to phrase-match); all `lisa-*` + both `marge-*` need wavsource.com whose audio path 404s on direct download; 6 obscure `shared-*` (dispatch, ghostcars, gotacall, music, trampoline, wellbye) had no confident source. Working sources used: thesoundarchive.com/simpsons, frogstar.com/wav/the-simpsons, soundfxcenter (binary downloads from soundfxcenter were ERR_CONNECTION_RESET on this machine - only server-side WebFetch reaches it).
- **HotS 7** (`anub-arak/azmodan/chen/kharazim/mephisto/rehgar/rexxar` -laugh): no Laugh VO exists in jamiephan OR heroesofthestorm.fandom hero audio. These are pool clips (unslotted), low impact. Likely unfixable from standard sources.
- **army-men 4** (hoover-attacked-1, hoover-move-1/2, shrap-spotted-1): the PC release of Army Men RTS ships NO audio data for hero unit voice (verified by carving every NORK `.x` archive). Only cinematic briefing MP3s exist (s07_intro_hoover1.mp3 etc.) which don't match move/attacked/spotted actions. Probably unfixable.

## Approach
1. Ask Joe first whether to accept looser-phrase matches for family-guy (he flagged this as his call). If yes, pull the ~6-8 from realmofdarkness via the sounds.js id maps.
2. For simpsons Lisa/Marge: try an alternate source (yt-dlp from a Simpsons soundboard video, or a different soundboard host) for the named emotion lines; skip the non-descriptive `*-clip-N`/`*-line-1` (no phrase to match - would need audio audition).
3. HotS 7 laugh + army-men 4: confirm-and-accept as genuinely unsourceable, or try yt-dlp last-resort.
4. Same rules as the main run: full-length only, never crop; <=5s keep, 5-10s replace+log under `## 5-10s clips pending approval` in COMMENTS_FOR_BEPY.md; playable formats only (wav/mp3/ogg-vorbis); replace IN PLACE keeping the exact filename; verify each write LANDED via mtime+duration oracle (do NOT trust subagent self-reports - see memory verify-subagent-writes-landed). Data is outside the repo; raw git for any in-repo bookkeeping.

## Acceptance
Every clip in `.for_bepy/resource_unresolved.txt` either re-sourced full-length (verified by mtime+duration oracle) and removed from the unresolved list, OR confirmed genuinely unsourceable and explicitly noted. Net unresolved count reported.
