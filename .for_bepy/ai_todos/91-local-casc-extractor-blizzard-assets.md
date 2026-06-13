# Fix the local CASC extractor (storm-extract) for square Blizzard hero portraits

## Goal

Get real **square** in-game hero portraits for the Heroes of the Storm characters (and, in principle, other Blizzard CASC titles) by repairing the local `storm-extract` tool, so avatars stop being transparent hexagons. Currently parked: the immediate square-portrait need can be served from the web; this is the canonical-source upgrade for later.

## Context

- The sidebar/header avatars use `<app-data>/characters/heroes-of-the-storm/<id>/icon.png`. Those 90 icons were sourced from the **online** repo `HeroesToolChest/heroes-images` → `heroesimages/heroportraits/storm_ui_glues_draft_portrait_<codename>.png`, which are the **hexagonal** draft-pick portraits (transparent corners). That repo has no square variant anywhere (checked `units`, `heroportraits`, etc.).
- Frontend currently hides the hexagon with a blurred-backdrop trick (`src/views/sessions/sidebar.ts` `leadingVisual`, `.session-char-backdrop` in `sessions.css`) and the header circle has a status ring. That stays as the fallback regardless; this todo is about getting genuinely square art.
- The square portraits are an **in-game CASC asset** (e.g. `storm_ui_ingame_hero_leaderboard_<codename>`), not in any tidy online repo. Local install: `C:\Program Files (x86)\Heroes of the Storm\HeroesData` (the CASC storage). WSL path: `/mnt/c/Program Files (x86)/Heroes of the Storm`.
- Tooling exists but is **broken**: `~/storm-extract` (WSL) is checked out and built (`~/storm-extract/build/bin/storm-extract`). It **opens** the CASC storage fine with the real `-i` path (no-arg default path cleanly prints "Failed to open storage"), but the moment it iterates files it aborts inside the bundled **CascLib** with a libstdc++ `basic_string::operator[]` out-of-bounds assertion. Diagnosis: the vendored CascLib predates the 2026 HotS storage format. `searchArchive()` in `src/storm-extract.cpp` is fine; the crash is inside `CascFindFirstFile`/`NextFile`. Note `-q`/`--quiet` also crashes separately (empty-output path).
- Scope reality (from a /rate-it, scored 4/10 as a "general other-games fix"): **CASC is Blizzard-only**. This does NOT help the Sims, Army Men, or even Warcraft 3 (that's MPQ, the older Blizzard format). It only generalizes to other Blizzard *CASC* titles (SC2, Diablo, Overwatch, WoW). Don't sell/scope it as a universal extractor.
- Codename map + slot classifier live in the memory `project_hots_character_sources` (e.g. amazon=Cassia, demonhunter=Valla, sgthammer=SgtHammer, etc.). Cho and Gall are separate ids.

## Approach

1. Update the bundled **CascLib** to a current maintained version (the submodule under `~/storm-extract/CascLib`), rebuild storm-extract. Verify it can list a known current asset (e.g. `-f GameData.xml`) without aborting.
2. Expect **TACT/encryption** hurdles on newer assets - some entries need keys. If the leaderboard portraits are encrypted, source the keys (CascLib supports a key file) or fall back to web for those.
3. Extract the square portrait per hero: `storm_ui_ingame_hero_leaderboard_<codename>.dds` (confirm exact name by searching CASC once it lists). DDS → PNG (Pillow can't read DDS directly; use `imagemagick`/`Pillow`+`dds` plugin or `texconv` in WSL), crop to square, then **flatten onto an opaque background** (see `/character-creator` `sprite-sources.md` "ALWAYS flatten transparency") so the result is an opaque RGB rectangle.
4. Replace `icon.png` per hero only after eyeballing a couple (cho, jaina) - keep the hexagon original backed up until the squares are confirmed good.
5. Wire this into `/character-creator` as an **optional Blizzard-CASC-only** icon source, documented as such. Rejected alternative: framing it as a general "other games" extractor (it isn't - CASC only).

## Acceptance

- `storm-extract -i "<HotS path>" -f leaderboard_jaina` lists results without the `operator[]` abort; `-x` extracts a DDS.
- Produced `icon.png` is square and `Image.open(...).mode == "RGB"` (no alpha) - renders cleanly in both the sidebar full-height strip and the header circle with no hexagon silhouette.
- Must NOT regress: the blurred-backdrop fallback and header status ring stay working for any hero whose square art can't be extracted (encryption/missing). Don't bulk-overwrite all 90 until cho+jaina are visually verified.
- Dependency to flag to Joe at execution time: needs the HotS install present + the WSL `storm-extract` build; updating CascLib may need a one-time `sudo` for build deps.
