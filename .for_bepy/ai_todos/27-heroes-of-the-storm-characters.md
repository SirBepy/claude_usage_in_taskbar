# Heroes of the Storm character bundles

## Goal

Build a set of HotS heroes as character bundles. Joe needs to specify the exact heroes he plays most before this executes.

## Context

Joe expressed interest on 2026-06-05. He plays HotS a lot but went to sleep before naming specific heroes. Tentative list from the session:

**Tentative (pending Joe's confirmation):**
- The Butcher ("FRESH MEAT!")
- Deckard Cain ("Stay a while and listen!")
- Illidan ("You are not prepared!")
- Abathur ("Evolution complete" - beloved weird character)
- Murky (baby murloc - speaks murloc + funny translated lines)
- ETC (rock band orc - Stage Dive etc.)

**Joe said he'll name the exact heroes he plays a lot** - ask him before starting: "Which HotS heroes do you want? (I have a tentative list of 6 from last session - confirm or replace)"

## Approach

Follow `/character-creator` skill (Steps 1-9). Key notes for HotS:

1. HotS voice lines are stored in the game's `.casc` files - modding communities have ripped them. Search archive.org for "Heroes of the Storm voice lines" or "HotS sound rip". Sites like HeroesFireplace or fan wikis often have per-hero clip pages.
2. Each hero belongs to a source universe (Diablo, Warcraft, StarCraft, Overwatch) - use `game: "heroes-of-the-storm"` for all of them regardless, since they're HotS-specific recordings with HotS-specific lines.
3. HotS heroes often have "pissed" lines (annoyed slot) that are extremely quotable - prioritize hunting those.
4. Murky is a special case: his "lines" are murloc gurgles. Look for the translated subtitle versions as clip labels.

## Acceptance

- Joe confirms the final hero list first (ask at session start).
- Each hero dir at `%APPDATA%\claude-usage-tauri\characters\heroes-of-the-storm\<hero>\` with `character.json` + `icon.png` + slots.
- Refresh Characters view - `HEROES OF THE STORM` group appears with correct chars.
