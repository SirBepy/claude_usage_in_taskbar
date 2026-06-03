# Remove rename phase from /close skill

## Goal
Strip Phase 4 (session rename) from the /close skill and make `-Name` optional in `rename-session.ps1` so Phase 7 can close the terminal without also renaming.

## Context
Chats now auto-rename themselves mid-conversation via the `<cc-title:..>` marker (emitted every turn, read at messages 1/5/15). The `/close` Phase 4 rename is therefore redundant and can be removed. The task was attempted in session but blocked because `Edit(~/.claude/skills/**)` uses tilde which doesn't resolve to `C:\Users\tecno\` on Windows. The Windows allow entry is missing.

## Approach

**Step 1 - Fix permissions first** (use `/update-config`):
Add `"Edit(C:/Users/tecno/.claude/skills/**)"` and `"Write(C:/Users/tecno/.claude/skills/**)"` to the allow list in `C:\Users\tecno\.claude\settings.json`.

**Step 2 - Update `rename-session.ps1`** (`C:\Users\tecno\.claude\skills\close\rename-session.ps1`):
- Change `[Parameter(Mandatory=$true)]` to `[Parameter(Mandatory=$false)]`
- Add default: `[string]$Name = ""`
- Wrap lines 80-102 (the rename/write block) in `if ($Name) { ... }`
- The `-Close` path works unchanged when called without `-Name`

**Step 3 - Update `SKILL.md`** (`C:\Users\tecno\.claude\skills\close\SKILL.md`):
- Frontmatter: remove "rename," from description line
- Remove Phase 4 ("Rename session") entirely (lines ~101-117)
- Renumber: Phase 5 → 4, Phase 6 → 5, Phase 7 → 6
- Update cross-references: "Skip Phase 7" → "Skip Phase 6" in what-was-Phase 6
- Update Phase 5 counter summary line: remove `renamed to "<name>"` token
- Update Phase 7 (now Phase 6) command: change `-Name "<name>" -Close` to just `-Close`
- Update the Why-literal callout to say "close-terminal helper" instead of "rename helper"

## Acceptance
- `/close` runs through all phases without attempting a rename
- The terminal still closes at the end (the PS script `-Close` path is intact)
- `rename-session.ps1` still works when called WITH `-Name` (backward compat for any external callers)
