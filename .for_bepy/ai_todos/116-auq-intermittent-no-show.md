---
id: 116
slug: auq-intermittent-no-show
title: Investigate why in-app-chat AskUserQuestion pickers SOMETIMES don't render
status: open
---

## Problem

When the in-app headless `claude -p` fires an `AskUserQuestion`, the picker USUALLY renders fine in the chat (Joe confirmed 2026-06-16 - they normally show). But it intermittently fails: in one autopilot session a first 4-question AUQ rendered + returned answers, then the very next AUQ errored at the tool layer with `relay error: error sending request for url (http://127.0.0.1:27182/permissions/request)` and never surfaced to Joe. Need to find why it's intermittent.

## Suspects (investigate, don't assume)

- **Port-27182 contention / pipe wedge.** A concurrent dev daemon (e.g. another autopilot's `cargo tauri dev`, or `/supervised-run`) seizing the hook port makes the relay POST fail to send. Overlaps memories `project_daemon_port_hostage` + `project_app_daemon_pipe_wedge`. The error is a request-SEND failure, not a 4xx, which fits a wedged/contended listener.
- **Lossy notifier broadcast.** The `question_request` frame can be dropped under pipe backpressure (memory `project_daemon_notifier_broadcast_lossy`); the must-deliver path is the `list_pending_prompts` poll. Confirm the question card's poll fallback actually fires when the broadcast frame is lost, so a dropped frame still renders the card.
- **Card render race.** The PreToolUse-hook relay (`daemon/hooks_server/permission.rs::on_ask_question_hook` -> `question_request` -> the chat question card) vs the chat being mid-render / not subscribed yet.

## Acceptance

- Root cause of the INTERMITTENT non-render identified with a repro or a captured daemon.log of a failing instance (not a guess).
- A fix or a concrete mitigation (e.g. poll-fallback guaranteed to render the card even when the relay send / broadcast frame is lost), or a documented "this only happens when N daemons share 27182" with the boundary.
- Do NOT regress the normal path where AUQs render fine.

## Note

Supersedes the old (wrong) belief that AUQ "never renders in app chat" - it usually does. This is about the intermittent failure only.
