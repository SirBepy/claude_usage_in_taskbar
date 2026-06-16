---
id: 112
slug: revisit-chat-border-color-system
title: Revisit the chat border-color system - red is overloaded
status: decided
---

## Decision (Joe, 2026-06-16)
**Closing keeps RED; "asking a question" / needs-attention moves to AMBER/yellow.** Build the coherent palette around that: red is reserved for the terminal "closing/shutting down" state, amber for "needs your input" (question/permission-pending), with the remaining states (busy, idle, error/rate-limited, remote=blue per ai_todo 113) each getting a distinct, documented hue. Implement as the single-source-of-truth CSS-prop map called for in Scope.

## Why
Border/state colors on chat rows + panes have grown ad-hoc and now collide. Red is used for BOTH "asking a question" (needs attention) AND, as of the close-leak fix, the "closing" state. Two different meanings sharing red is confusing. Joe wants a coherent pass over ALL the chat state colors.

## Scope
Audit every chat state that drives a border/row color and define a coherent palette with no collisions. Known states today:
- asking a question / needs attention (currently red)
- closing / shutting down (currently also red - the close-leak fix, with a pulse + "closing…" label to partly distinguish)
- remote chat (currently a blanket BLUE border override - see ai_todo 113)
- busy / running, idle, permission-pending, error/rate-limited, etc.

Produce a single source of truth (CSS custom props or a documented map) so each state has a distinct, intentional color, and reassign the overlaps (give "closing" or "question" its own hue).

## Acceptance
- No two distinct states share the same border color by accident.
- Documented palette (one place) mapping state -> color.
- Closing vs question are visually unambiguous.
