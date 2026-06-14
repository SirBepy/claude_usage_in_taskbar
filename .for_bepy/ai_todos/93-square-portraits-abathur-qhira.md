# Web-source square portraits for abathur + qhira (the 2 local-CASC gaps)

## Goal

Give Abathur and Qhira square opaque hero portraits to match the other 88 heroes, since the local Heroes of the Storm install has ZERO assets for them (partial CASC download - the game only fetches owned/played heroes). They currently fall back to the hexagonal draft portrait + blurred backdrop.

## Context

- ai_todo 91 swapped 88/90 HotS hero icons to square `storm_ui_ingame_heroselect_btn_<codename>.dds` (128px, opaque RGB). Recipe + id->codename map + the storm-extract details are in the memory `project_hots_character_sources`.
- `abathur` and `qhira` returned 0 dds from the local CASC (`storm-extract -f abathur` / `-f qhira` / `-f nexushunter` all empty). Confirmed not a naming issue: they are simply not downloaded locally.
- Icons live at `%APPDATA%\claude-usage-tauri\characters\heroes-of-the-storm\<id>\icon.png` (OUT of the git repo). Old hexagon backups for the swapped heroes are at `C:\tmp\hex_icon_backup\<id>.png` (NOT abathur/qhira - those were never overwritten).
- The blurred-backdrop hexagon fallback in `src/views/sessions/sidebar.ts` + `sessions.css` already handles these two cleanly, so this is a polish nicety, NOT a bug.

## Approach

1. Source a square in-game portrait for each from the web (the assets exist online even if not in the local install). Good sources used elsewhere in this project: the Fandom MediaWiki `allimages` API (curl + browser UA, WebFetch 403s) and `HeroesToolChest/heroes-images`. Look specifically for a square `heroselect_btn` / `hero_icon` style render, NOT the hexagonal `draft_portrait`.
2. Convert to 128x128, flatten onto opaque bg (30,30,34), save as RGB PNG (`Image.open(...).mode == "RGB"`) using Windows python + Pillow (already installed; WSL python has no pip).
3. Back up the existing hexagon icon to `C:\tmp\hex_icon_backup\` first, then overwrite `<id>/icon.png` for `abathur` and `qhira`.

## Acceptance

- `abathur` and `qhira` `icon.png` are square and `mode == "RGB"` (no alpha), visually a real portrait not the hexagon.
- Render a 2-tile sheet and show Joe before declaring done (he may reject an awkward one - see memory `feedback_surface_awkward_assets`).
- If no good square render is findable for one of them, leave it on the hexagon fallback and say so - do not ship a bad crop.