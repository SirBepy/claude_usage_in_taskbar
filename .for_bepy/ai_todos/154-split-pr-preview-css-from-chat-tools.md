# Split PR-preview CSS out of chat-tools.css

## Goal

Move the PR preview card + modal styles out of `chat-tools.css` into their own file so the file matches its name (tool-chip UI only).

## Context

`src/shared/chat/chat-tools.css` is 735 lines and mixes several distinct concerns behind one name that implies "tool chips":

- AskUserQuestion inline rendering (~line 40)
- Inline tool chip strip (~line 75)
- PR Preview card + modal (~line 292-566, ~275 lines) - a self-contained, unrelated feature (the `/create-pr` skill's preview card), not a tool-chip concern at all
- AUQ question card (~line 567)
- Per-turn footer / meta row (~line 648)

The PR preview block is the clearest seam: it's ~275 contiguous lines, has its own two banner comments (`PR Preview card + modal`, `PR modal overlay`), and has no structural dependency on the tool-chip rules around it.

## Approach

1. Create `src/shared/chat/pr-preview.css` (or similar) and move the `PR Preview card + modal` and `PR modal overlay` sections (roughly lines 292-566) into it verbatim.
2. Add the new stylesheet wherever `chat-tools.css` is currently imported/linked (check `index.html` or the relevant TS import).
3. Leave the AUQ/tool-chip/turn-footer sections in `chat-tools.css` - they're still mixed but each is smaller and more plausibly tool-adjacent; a further split isn't obviously needed.

## Acceptance

- `chat-tools.css` no longer contains PR-preview-specific selectors.
- The PR preview card/modal still renders correctly (verify by triggering `/create-pr`'s preview or reviewing the CSS diff for lost rules).
- No other file references `chat-tools.css` expecting the PR-preview classes to live there (grep for the class names used in `chat-transforms.ts`'s PR preview renderer, e.g. `detectPrPreviewToken` consumers).
