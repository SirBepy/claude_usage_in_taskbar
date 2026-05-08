# Phase 5d - markdown-it + shiki integration

## Context

Implements Task 5.5 of `docs/superpowers/plans/2026-05-07-claude-chat-hub.md`. Depends on Phase 5b (chat-renderer.js exists with placeholder `renderMarkdown`).

## PRE-APPROVED INSTALL

User pre-approved installing `markdown-it` and `shiki` for this project. Both are MIT-licensed, mainstream, frontend-only. Skip the "ask before installing" gate that the parent plan calls for.

## Goal

- Install `markdown-it` and `shiki` via the project's package manager (likely `pnpm` based on the repo layout; if not, fall back to `npm` or `yarn` based on lockfile).
- Replace `renderMarkdown` in `src/modules/chat-renderer.js` to use `markdown-it`.
- Add a post-render pass `highlightCodeBlocks()` that uses `shiki`'s `codeToHtml` to syntax-highlight code blocks. Call it after each render.

## Implementation

1. Detect the package manager:
   - If `pnpm-lock.yaml` exists -> `pnpm add markdown-it shiki`
   - Else if `yarn.lock` -> `yarn add markdown-it shiki`
   - Else -> `npm install markdown-it shiki --save`

2. Modify `src/modules/chat-renderer.js`:
   - Add imports at the top:
     ```js
     import MarkdownIt from 'markdown-it';
     import { codeToHtml } from 'shiki';
     ```
   - Initialize once per module load:
     ```js
     const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
     ```
   - Replace `renderMarkdown`:
     ```js
     function renderMarkdown(text) { return md.render(text); }
     ```
   - Add async method to `ChatRenderer`:
     ```js
     async highlightCodeBlocks() {
       const blocks = this.container.querySelectorAll('pre code');
       for (const code of blocks) {
         const lang = (code.className.match(/language-(\S+)/) || [])[1] || 'text';
         try {
           const html = await codeToHtml(code.textContent, { lang, theme: 'github-dark' });
           code.parentElement.outerHTML = html;
         } catch { /* unknown language, leave as-is */ }
       }
     }
     ```
   - In `render()`, after setting innerHTML, call `this.highlightCodeBlocks().catch(() => {})`. Don't await - let highlighting happen async without blocking.

3. Verify `cargo build -p claude-usage-tauri` clean (no Rust changes).
4. Run the full lib test suite. Should still be 174.

## Gotchas

- Shiki's `codeToHtml` is async and returns a string. Don't try to use it synchronously.
- markdown-it's `html: false` is intentional - prevents users injecting HTML via assistant responses.
- Don't add a custom highlight callback to markdown-it. Let it emit standard `<pre><code class="language-X">`, then post-process with shiki. Simpler and avoids sync/async mismatch.
- If `pnpm` is the package manager and `pnpm-lock.yaml` is committed, the new packages must update the lockfile. The night-run tick's `/commit` will handle that automatically as part of the staged changes.

## Don't

- Don't commit (night-run handles).
- Don't pin specific versions; let the package manager pick the latest stable.
- Don't add other markdown plugins (linkify is built-in to markdown-it).
- Don't try to highlight inline `<code>` (only fenced code blocks - i.e. `<pre><code>...`).

## Acceptance

- `markdown-it` and `shiki` are in `package.json` dependencies.
- Lockfile updated.
- Chat renderer uses markdown-it for assistant text and shiki for fenced code blocks.
- 174 lib tests still pass.
- `cargo build -p claude-usage-tauri` clean.
