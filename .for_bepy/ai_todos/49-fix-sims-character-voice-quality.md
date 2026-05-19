# Fix sims character voice repetition and cut-off audio

## Goal

Redistribute sims character sound slots so clips don't repeat noticeably across the set, and replace or drop clips that sound cut off mid-word.

## Context

Joe's feedback at session close (2026-05-17): voices were too repetitive (same file assigned to multiple slots) and many clips sounded cut off. The distribution script (`C:\tmp\sims_distribute.py`) used a pool-based approach that drew from the same candidate list for work_finished / question_asked / ready / select - producing audible repetition within one character and across chars that share voice actors.

The 2-5s clip trim-to-2s policy also produced abrupt endings. Short clips that naturally end ≤2s should be preferred over trimmed versions of longer clips.

Char/voice actor assignments as built:
- bella-goth: F1 pool
- mortimer-goth: M1 pool  
- adult-female: F2-F6 pool (excluded F1)
- adult-male: M2+ pool (excluded M1)
- child: K pool (kid voices)
- baby: infant/baby sounds

Character bundle dir: `%APPDATA%\claude-usage-tauri\characters\sims\<char>\character.json` (slots field).

Sound source: `%APPDATA%\claude-usage-tauri\characters\sims\_shared\` (or per-char dirs). Original 1662 WAV files were from the Sims 1 SFX Library on archive.org (`sims-1-sfx-library`, Voice.zip).

## Approach

1. Audit current slot assignments - read `character.json` for each char and identify repeated filenames across slots.
2. For each char, build non-overlapping subsets per slot: assign best-fit clips to work_finished, then from the remainder to question_asked/ready/select. If pool is small, allow work_finished / question_asked / ready / select to share (per Joe: "its fine"), but ensure death/annoyed are distinct if filled.
3. Drop or swap clips that sound abrupt. Prefer clips ≤2s natural length. If a clip was trimmed to 2s in the prior pass, check original length and drop if trimming cut a word.
4. Update `character.json` slot arrays in place (or rerun a revised distribute script).

## Acceptance

- No filename appears in both work_finished AND question_asked/ready/select for the same character (unless pool literally has only 1 clip).
- Spot-check 3 chars in the app's Characters view: play each slot, confirm different voice line plays on consecutive triggers.
- No audibly cut-off clips (sentence ends naturally or at a pause).
