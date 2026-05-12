# Drop dead exports from slash-registry

## Goal
Remove or wire up the unused `getSlashEntries` and `getSlashSource` exports so the registry module has no dead surface.

## Context
`src/shared/chat/slash-registry.ts` exports four functions, two of which have no callers:

- `getSlashEntries()` — grep count = 1 (definition only).
- `getSlashSource(name)` — grep count = 1 (definition only). Previously used by `chat-renderer.ts::highlightSlashMentions`, but that consumer was switched to `lookupSlash` (which handles the `plugin:name` form). The bare-name lookup `getSlashSource` exposes is now redundant with `lookupSlash`.

`lookupSlash` and `skillDetailTarget` are live (multiple callers in chat-renderer).

## Approach
Delete both `getSlashEntries` and `getSlashSource` from `slash-registry.ts`. They are not needed: the registry is write-by-provider, read-by-renderer, and the renderer only reads via `lookupSlash`. If a future feature needs raw enumeration or strict-bare-name lookup, re-add at that point with a real caller.

## Acceptance
`grep -r "getSlashEntries\|getSlashSource" src/` returns zero results, or each surviving export has at least one caller outside its own definition site.
