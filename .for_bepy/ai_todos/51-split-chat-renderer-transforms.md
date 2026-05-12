# Split chat-renderer.ts post-processing helpers into separate modules

## Goal
Reduce chat-renderer.ts from 755 lines by extracting the post-processing helpers that have no dependency on ChatRenderer's private state.

## Context
`src/shared/chat/chat-renderer.ts` is 755 lines and mixes three concerns: (1) ChatRenderer class DOM lifecycle/incremental-update logic, (2) markdown post-processing helpers (highlightCodeBlocks, wrapBlockquotes, cleanUserBlocks), and (3) slash-mention HTML transform (highlightSlashMentions + SLASH_MENTION_RE + COMMAND_TAG_RE + SKILL_BODY_RE). The post-processing helpers are pure functions with no access to ChatRenderer's private fields.

## Approach
1. Extract `highlightSlashMentions`, `SLASH_MENTION_RE`, `COMMAND_TAG_RE`, `SKILL_BODY_RE`, `cleanUserBlocks`, `wrapBlockquotes` into `src/shared/chat/chat-transforms.ts`.
2. Extract `highlightCodeBlocks` (shiki post-pass) into `src/shared/chat/code-highlighter.ts`.
3. Update `chat-renderer.ts` to import from the new modules.
4. Verify `pnpm tsc --noEmit` passes.

## Acceptance
- `chat-renderer.ts` is under 500 lines.
- `chat-transforms.ts` and `code-highlighter.ts` are new files, each under 200 lines.
- Build succeeds, no TS errors.
