# Wire the local-CASC square-portrait source into /character-creator (Blizzard-only)

## Goal

Make `/character-creator` able to pull SQUARE in-game hero portraits from a local Blizzard CASC install (proven out in ai_todo 91 for Heroes of the Storm), documented explicitly as a Blizzard-CASC-only icon source - not a general extractor.

## Context

- ai_todo 91 established the working recipe (no CascLib rebuild, no sudo needed): targeted `storm-extract -i "<HotS path>" -f heroselect_btn -t dds -x` extracts square `storm_ui_ingame_heroselect_btn_<codename>.dds`; DDS->PNG via Windows python+Pillow. Full details, the id->codename alias map, the tall-asset gotcha (chogall/barbarian are 75x201 - use 76px `hero_icon` instead), and the abathur/qhira partial-install gaps are all in the memory `project_hots_character_sources`.
- `/character-creator` skill lives at `~/.claude/skills/character-creator/` (OUTSIDE this repo). Its sprite/icon sourcing doc is `sprite-sources.md` (referenced by 91 for the "ALWAYS flatten transparency" rule). Editing files under `~/.claude` on Windows needs an `Edit(C:/Users/tecno/.claude/**)` permission - add via `/update-config` first (see memory `feedback_claude_skills_write_permission`).
- SCOPE REALITY (from a /rate-it, 4/10 as a "general fix"): CASC is Blizzard-ONLY. Does not help Sims/Army Men/Warcraft3(MPQ). Only generalizes to other Blizzard CASC titles (SC2, Diablo, Overwatch, WoW). Document it as such; do NOT frame it as a universal extractor (rejected alternative).

## Approach

1. Add a documented optional icon source to `~/.claude/skills/character-creator/sprite-sources.md`: "Blizzard CASC (local install)" with the storm-extract command, the codename-map note, the tall-asset aspect-check warning, and the Windows-Pillow conversion step.
2. Make it OPT-IN / fallback-aware: web sources stay the default; CASC is for when a square in-game portrait is wanted and a local Blizzard install is present.
3. Keep the existing flatten-transparency step.

## Acceptance

- `sprite-sources.md` documents the CASC square-portrait source, explicitly labelled Blizzard-CASC-only, with the exact storm-extract + Pillow recipe.
- A future cold session can follow it to extract a square portrait without re-deriving the recipe.
- No claim that it works for non-CASC games.