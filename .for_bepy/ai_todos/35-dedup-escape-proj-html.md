---
name: 35-dedup-escape-proj-html
description: escapeProjHtml in projects.ts duplicates escapeHtml; missed during the 30 escapeHtml extract
type: project
---

# Replace escapeProjHtml with shared escapeHtml

## Goal

Delete `escapeProjHtml` from `src/shared/projects.ts` and migrate its callers to import the shared `escapeHtml` from `src/shared/escape-html.ts`.

## Context

When ai_todo 30 extracted `escapeHtml` to `src/shared/escape-html.ts` (2026-05-11), it covered the 4 known call sites: `sessions.ts`, `history.ts`, `project-detail.ts`, `chat-renderer.ts`. It missed a fifth implementation hiding under a renamed alias in `src/shared/projects.ts`:

- `src/shared/projects.ts:44-55` defines `export function escapeProjHtml(s: string | null | undefined): string` with the exact same `&/<>/"/'` replacement chain (just typed slightly differently to accept `string | null | undefined`).
- Callers in same file at lines 59 and 65 (`renderAvatar`).
- Anywhere else in the repo that imports `escapeProjHtml` should be checked too via grep.

The shared `escapeHtml` already accepts `string` and uses `String(s ?? "")` internally for the null-guard, so the type widening is a non-issue.

## Approach

1. `grep -rn "escapeProjHtml" src/` to find all import sites.
2. Replace `escapeProjHtml(x)` calls with `escapeHtml(x)`.
3. In each file that imported `escapeProjHtml`, swap to `import { escapeHtml } from "../shared/escape-html"` (adjust depth per caller).
4. Delete the function definition in `src/shared/projects.ts`.
5. Update the file's top-of-file ported-from comment that names `escapeProjHtml`.
6. `pnpm tsc --noEmit` clean.
7. `pnpm vitest run` still 64 passing.

## Acceptance

- `escapeProjHtml` defined nowhere in the tree (`grep -rn "escapeProjHtml" src/` returns zero matches).
- `escapeHtml` defined exactly once in `src/shared/escape-html.ts`.
- TypeScript + vitest clean.
