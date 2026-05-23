# Update sound-sources.md: Sounds Resource accessible with browser UA

## Goal
Document that sounds.spriters-resource.com works with a browser User-Agent header, including the per-character zip download pattern for SSBU and other games.

## Context
`~/.claude/skills/character-creator/sound-sources.md` currently lists `sounds-resource.com` and `sounds.spriters-resource.com` as 403-blocked. This is wrong when a browser UA is passed. Confirmed working in 2026-05-23 session:
- `curl -sI https://sounds.spriters-resource.com/... -A "Mozilla/5.0 ..."` returns HTTP 200
- Per-character zip download URL pattern: `https://sounds.spriters-resource.com/media/assets/<dir>/<asset_id>.zip`
- No auth required, just the User-Agent header
- Each character page has a `data-file` attribute containing the zip path

## Approach
1. Open `~/.claude/skills/character-creator/sound-sources.md`
2. Move `sounds.spriters-resource.com` OUT of the "Sites that BLOCK with 403" section
3. Add a new entry in "Sites that WORK" documenting: browser UA required, per-char zip URL pattern, how to scrape `data-file` from asset pages
4. Add a note: for bulk game rips, scrape the game's asset list page first to get all asset IDs, then fetch each asset page for its zip URL

## Acceptance
sound-sources.md no longer lists Sounds Resource as blocked, and has working download instructions a future session can follow cold.
