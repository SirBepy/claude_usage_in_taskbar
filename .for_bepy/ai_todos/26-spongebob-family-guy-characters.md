# SpongeBob + Family Guy + Simpsons character bundles

## Goal

Build 14 characters across three cartoon franchises using the `/character-creator` skill workflow. Output goes to `%APPDATA%\claude-usage-tauri\characters\`.

## Scheduled run (2026-06-05)

Runs via a one-shot `/autopilot` Windows Scheduled Task at 19:00 (`.for_bepy/run-autopilot-cartoons.ps1`), staggered 2h after the HotS run. Scope confirmed by Joe; no interactive picking - autopilot auto-resolves Step 7.

## Context

Joe chose these during a session on 2026-06-04. He went to sleep before the interactive slot-picking step (Step 7) could run, so the work was deferred. The character-creator skill is at `C:\Users\tecno\.claude\skills\character-creator\`. The warcraft3 duplicate was already removed this session.

**Characters to build:**

- Game: `spongebob` (SpongeBob SquarePants)
  - `spongebob`, `patrick`, `squidward`
- Game: `family-guy`
  - `stewie`, `peter`, `brian`, `quagmire`, `cleveland`, `meg`
- Game: `simpsons` (The Simpsons)
  - `homer`, `marge`, `bart`, `lisa`, `abe` (Grandpa / Abraham Simpson) - the family except Maggie, plus Grandpa

## Approach

Follow the `/character-creator` skill exactly (Steps 1-9). Key reminders:

1. Read `sprite-sources.md` and `sound-sources.md` in the skill base dir before searching.
2. Bulk-zip strategy: one archive.org download per franchise covers all chars.
3. Hard clip rule: discard > 5s, trim kept clips to <= 2s.
4. Step 7 requires Joe to pick slots interactively - do NOT skip or auto-assign. Surface AskUserQuestion for each char.
5. Shared bundle: create a `_shared` bundle per game for sounds that apply to the whole cast (generic reactions, etc.) to avoid duplicating across chars.
6. Filename convention: `<char-slug>-<original-action>-<n>.<ext>` - not slot-named.

Sound search terms that tend to work:
- SpongeBob: "spongebob squarepants sound effects", "spongebob voice clips archive"
- Family Guy: "family guy soundboard", "family guy sound clips archive.org"

## Acceptance

- Each char dir exists at `%APPDATA%\claude-usage-tauri\characters\<game>\<char>\` with `character.json` + `icon.png` + at least 3 slots filled.
- Refresh the Characters view in the Claude Usage app - both games appear with correct grouping, no duplicates.
- Peon (Orc) under Warcraft III: The Frozen Throne still shows 6/6 (confirm warcraft3 deletion didn't break anything).
