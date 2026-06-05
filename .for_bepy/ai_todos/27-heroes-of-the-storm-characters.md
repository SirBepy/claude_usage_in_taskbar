# Heroes of the Storm character bundles

## Goal

Build the ENTIRE HotS hero roster as character bundles.

## Scope (CONFIRMED 2026-06-05)

Joe confirmed: **EVERY hero (~90), the full roster. Do NOT ask which heroes.** This supersedes the earlier "name the ones you play" gate. Scheduled to run via a one-shot `/autopilot` Windows Scheduled Task at 17:00 on 2026-06-05 (`.for_bepy/run-autopilot-hots.ps1`).

Heroes that are extra-quotable (build these well if time-constrained):
- The Butcher ("FRESH MEAT!")
- Deckard Cain ("Stay a while and listen!")
- Illidan ("You are not prepared!")
- Abathur ("Evolution complete" - beloved weird character)
- Murky (baby murloc - speaks murloc + funny translated lines)
- ETC (rock band orc - Stage Dive etc.)

## Approach

Follow `/character-creator` skill (Steps 1-9). Key notes for HotS:

1. HotS voice lines are stored in the game's `.casc` files - modding communities have ripped them. Search archive.org for "Heroes of the Storm voice lines" or "HotS sound rip". Sites like HeroesFireplace or fan wikis often have per-hero clip pages.
2. Each hero belongs to a source universe (Diablo, Warcraft, StarCraft, Overwatch) - use `game: "heroes-of-the-storm"` for all of them regardless, since they're HotS-specific recordings with HotS-specific lines.
3. HotS heroes often have "pissed" lines (annoyed slot) that are extremely quotable - prioritize hunting those.
4. Murky is a special case: his "lines" are murloc gurgles. Look for the translated subtitle versions as clip labels.

## Acceptance

- Build the full roster (~90); no confirmation needed (see Scope above).
- Each hero dir at `%APPDATA%\claude-usage-tauri\characters\heroes-of-the-storm\<hero>\` with `character.json` + `icon.png` + slots.
- Refresh Characters view - `HEROES OF THE STORM` group appears with correct chars.
