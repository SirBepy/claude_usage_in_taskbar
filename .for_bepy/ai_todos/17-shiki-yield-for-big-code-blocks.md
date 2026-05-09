# Verify shiki highlighting doesn't freeze on huge code blocks

## Goal

Confirm — and if needed fix — that a chat message containing a 100KB+ code block doesn't lock up the UI when shiki tokenizes it. Yield between code blocks in the highlighter pass.

## Context

`src/shared/chat/chat-renderer.ts::highlightCodeBlocks` runs after `flushRender`:

```ts
const codes = Array.from(
  this.container.querySelectorAll<HTMLElement>("pre > code:not([data-highlighted])"),
);
for (const code of codes) {
  ...
  const html = await codeToHtml(code.textContent ?? "", { lang, theme: "github-dark" });
  ...
}
```

`codeToHtml` is async (returns a Promise) but each individual block runs to completion before the next iteration continues. For a single 100KB code block, the browser thread may hitch for a noticeable beat while shiki tokenizes — this would explain residual freeze if a session has a giant fenced block. Multiple medium blocks back-to-back can also pile up because each `await` resolves microtask-fast and never yields a macrotask for paint.

## Approach

1. Reproduce: open a session known to contain a giant code block; open devtools Performance tab; watch the long task during chat load.
2. If confirmed, add a `setTimeout(0)` yield between code blocks:
   ```ts
   for (let i = 0; i < codes.length; i++) {
     // ... existing await codeToHtml(...) ...
     if (i + 1 < codes.length) {
       await new Promise<void>((resolve) => setTimeout(resolve, 0));
     }
   }
   ```
3. Optionally, defer the FIRST `highlightCodeBlocks` call too — let the whole transcript render unhighlighted, then progressively syntax-highlight in the background.

## Acceptance

- Reproduce + measure long-task duration in devtools.
- After fix: longest task during chat load <100ms even on a session with multiple huge code blocks.
- Highlighting still completes for every block (no missed `data-highlighted` markers).
