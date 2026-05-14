# Deduplicate MIME-to-icon mapping

## Goal
Extract the MIME → Phosphor icon logic into a single shared utility so it isn't maintained in two places.

## Context
The same mapping (pdf → `ph-file-pdf`, text/*/json → `ph-file-text`, other → `ph-file`) is implemented twice:
- `fileIcon(mime)` in `src/shared/chat/composer.ts:372-376`
- Inline `if/else if` branches in `hydrateAttachments` in `src/shared/chat/chat-renderer.ts:35-46`

If a new MIME type needs an icon, both files need updating — a classic DRY violation.

## Approach
1. Add a `mimeToIcon(mime: string): string` export to `src/shared/chat/attachment-hydrator.ts` (created in ai_todo #70), or to a new `src/shared/chat/mime-utils.ts` if #70 isn't done yet.
2. Replace `fileIcon` in `composer.ts` with an import of `mimeToIcon`.
3. Replace the inline branches in `hydrateAttachments` with `mimeToIcon` calls.
4. Delete `fileIcon` from `composer.ts`.

## Acceptance
- Single `mimeToIcon` function handles the mapping.
- Both composer pre-send chips and post-send hydrated chips use the same function.
- No behaviour change.
