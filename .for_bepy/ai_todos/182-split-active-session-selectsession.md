# src/views/sessions/active-session.ts should be split

## Goal
Break the giant `selectSession` function into smaller, independently-testable pieces so the 580-line file gets a real split seam instead of one monolithic function.

## Context
`src/views/sessions/active-session.ts:184-579` is a single `export async function selectSession(...)` that is roughly 400 lines long and mixes several distinct concerns end to end:
- Header + statusbar mount (active-session.ts:235-294)
- Renderer/messages-pane mount + all its callback wiring (active-session.ts:296-401)
- Composer + held-messages controller mount, including the `sendBundle` closure and the `/close` lifecycle watch (active-session.ts:404-527)
- File-watcher registration + read-only banner button wiring (active-session.ts:529-567)

Each of these blocks only reads/writes `pane`, `sess`, and a couple of already-computed locals (`sessionId`, `readOnly`, `header`) - they don't need the whole function's closure, so they're natural extraction candidates. The file was not touched by any of today's REFACTOR splits (git log shows `active-session.ts` untouched while `dashboard.ts`, `model-effort-modal.ts`'s account-field, `sidebar.ts`'s row-visuals, etc. all got split-out today), so it's the one file in this diff that's furthest past the ~400-line guideline with no attempt yet.

## Approach
Extract 2-3 focused helper functions (in this file or a new `active-session-mount.ts`) that `selectSession` calls in sequence, e.g.:
- `mountStatusbar(pane, sess): Promise<SessionStatusbar | null>`
- `mountRenderer(pane, sess, header, sessionId): Promise<void>` (renderer + changes panel + status/CTA wiring)
- `mountComposer(pane, sess, sessionId, readOnly): void` (composer + held-messages + sendBundle)

Keep `selectSession` itself as the orchestrator: guard clauses, pane HTML skeleton, then the three mount calls in order.

## Acceptance
`selectSession` is under ~150 lines and delegates to the extracted helpers; `cargo build`/`pnpm tsc --noEmit` (frontend typecheck gate) still passes; opening/switching chats in the app still works (statusbar, messages, composer, held-messages, read-only takeover all behave the same).
