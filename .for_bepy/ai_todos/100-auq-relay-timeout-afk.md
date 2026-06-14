# 100 - AUQ relay / permission-request poll times out when dev is AFK

## Problem
When the in-app chat surfaces an AskUserQuestion (or any permission-request relayed through the daemon at localhost:27182), the request times out if the dev doesn't answer within the window. Joe is sometimes AFK for a while and the question gets dropped (observed 2026-06-14: an AUQ during a brainstorm errored with "error sending request for url (http://127.0.0.1:27182/permissions/request)" after a long AFK gap).

## Task
Make the relayed question NOT time out (or use a much longer / effectively-infinite timeout) so an AFK dev can still answer when they return.

## Where to look
- The PreToolUse ask-question relay hook + `/hooks/ask-question` endpoint and the reliable poll loop (see memory: "AskUserQuestion relay via PreToolUse hook").
- The HTTP client timeout on the `POST /permissions/request` call (the error is a request-send/timeout failure, not a 4xx).
- Confirm the daemon side keeps the pending prompt alive (list_pending_prompts poll) regardless of how long the client waits.

## Acceptance
A relayed AUQ/permission prompt stays answerable after a long AFK gap (e.g. 30+ min) instead of erroring out.
