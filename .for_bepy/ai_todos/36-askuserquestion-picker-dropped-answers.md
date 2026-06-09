# AskUserQuestion picker silently drops the user's answers

## Goal

Fix the chat-hub permission/question relay so that when Claude (running headless `claude -p`) fires an `AskUserQuestion` and the user ANSWERS the in-app picker, the answers actually reach the model. Right now the model receives "user dismissed the question without answering" even though the user selected options.

## Context

Hit live on 2026-06-10: during a design conversation the assistant fired a 4-question `AskUserQuestion`; Joe answered all four, but the tool result came back as dismissed/empty, so the answers were lost and the assistant had to re-ask in plain text. This is the AskUserQuestion path, relayed via the per-session PreToolUse hook -> /hooks/ask-question -> poll (see memory "AskUserQuestion relay via PreToolUse hook" and the permission-modal question-card flow in `src/views/sessions/permission-modal/`). Suspect the answer payload shape or the submit->respond_question round-trip is being dropped (compare against the MCP `ask_user_question` path and `respond_question` IPC). Possibly related to the multi-question (4 at once) shape, or the answers object keying.

## Approach

Reproduce with a multi-question AskUserQuestion in an in-app chat. Trace: question-card `onSubmit` -> `invoke("respond_question", { id, answers })` -> Rust handler -> what the headless `claude -p` actually receives. Check the answers object shape the model expects (per-question keying) and whether dismiss-vs-submit is being conflated. Add a regression test at whatever seam is unit-testable (the relay/transform, not the GUI).

## Acceptance

- Answering an in-app AskUserQuestion picker (including a multi-question one) delivers the selected options to the model; it does NOT see "dismissed".
- A test covers the submit path's payload shape.
