# Skill suggestions miss /superpowers (esp. /brainstorming)

## Goal

Make Claude reliably recognize `/brainstorming` (and the rest of the `superpowers:*` skill family) as available skills when Joe types them, instead of dropping them and proceeding raw.

## Context

In conversation on 2026-05-19, Joe typed `/brainstorming` to trigger the `superpowers:brainstorming` skill. The slash command did not autocomplete / surface in suggestions, and Claude almost continued without invoking the skill. Joe noted the same has happened with bare `/superpowers`.

The skills DO show up in the session's available-skills list (system reminder enumerates `superpowers:brainstorming`, `superpowers:using-superpowers`, etc.), so the issue is the input layer (autocomplete / slash menu) not the loader.

Suspected causes (need to verify):
- The slash-command menu may filter by the part before `:` only, so plugin-namespaced skills require typing `/superpowers:` first.
- Or the menu doesn't index plugin-prefixed skills at all.
- See related memory `project_plugin_skill_keying.md` - SlashEntry.name is bare, InstalledSkill.skill is `plugin:name`. The autocomplete path may use one but not the other.

Relevant code (Tauri app side, if the menu lives in this repo's frontend):
- grep `src/views/sessions/composer*` and `src/shared/chat/*` for slash-menu / autocomplete code
- grep for `SlashEntry` / `slashEntries` / `installedSkills`

If the menu is owned by Claude Code itself (not this app), then this todo becomes: file an issue / open a PR upstream, OR add a local shim that rewrites bare `/brainstorming` -> `/superpowers:brainstorming` before sending.

## Approach

1. Find where slash-command suggestions are generated in this repo (composer autocomplete).
2. Confirm whether the suggestion source indexes plugin-namespaced skills.
3. Two paths depending on finding:
   - **In-app menu owns it**: extend the index to include both bare and `plugin:name` forms; suggest the plugin-prefixed form when there's no bare match.
   - **Claude Code owns it**: add a local rewrite at send-time so a leading `/brainstorming` (or other known plugin skill) gets resolved to `/superpowers:brainstorming` before dispatch. Maintain a small map of known plugin-skill aliases.
4. Either way, when typing `/brain` Joe should see `brainstorming` in the suggestion list.

Reject: prompting Joe to type `/superpowers:brainstorming` every time. He uses it constantly; the friction is the whole point.

## Acceptance

- Typing `/brain` in the chat composer surfaces `brainstorming` (from `superpowers`) in the suggestion menu.
- Typing `/super` surfaces `superpowers:*` skills.
- Pressing enter on the suggestion sends a message that triggers the skill (Claude invokes the Skill tool with the correct fully-qualified name).
- Other plugin-namespaced skills (e.g. `caveman:caveman-review`) work the same way without needing the prefix.
- Bare `/<name>` that collides with a non-superpowers skill keeps current behavior; superpowers is only used when there's no bare match (or rank superpowers below bare-named matches).
