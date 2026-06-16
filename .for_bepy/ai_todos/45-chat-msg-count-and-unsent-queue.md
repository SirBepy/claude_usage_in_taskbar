# Chat msg-count stuck at 1 + surface unsent/undelivered messages

## Re-scope (Joe, 2026-06-16)
The "outbox" of piece 2 ALREADY EXISTS - it's the held-messages queue (the "N waiting" chip). Do NOT build a new one. Joe's actual current pain: **held/queued messages do not auto-deliver when the AI finishes its turn** - they should flush automatically on turn-complete but don't reliably. This is despite commit a23104a ("FIX: held messages now auto-send when Claude finishes a normal turn"), so that fix is incomplete or regressed. So piece 2 becomes: **fix the held-message auto-flush on turn completion** (overlaps ai_todo 90's held-messages e2e and the recent held-messages work). Piece 1 (the msg-count stuck at 1) stays as-is and still needs a live broken-chat daemon.log.

## Symptom (Joe, 2026-06-10)

In one specific in-app chat the statusbar read `1 msg, 88 turns` even though Joe
had sent multiple messages (3-4). The msg count stayed at 1. The chat was also in
a bad state generally (he had to copy his messages out and open it in a terminal).
He suspects later messages are being SCHEDULED/QUEUED but never delivered to the
AI, so they're not counted.

## Two pieces

1. DIAGNOSE the count: `msgs` = `prompts` (user_prompts) from `instance_token_stats`
   IPC; `turns` = agent turns (see memory messages-vs-turns-definition). If turns=88
   but prompts=1, the daemon only counted one delivered user prompt. Figure out
   why subsequent sends didn't increment user_prompts: are they failing to reach
   the daemon/claude (send_message erroring, pipe wedged - see memory
   app-daemon-pipe-wedge), or being dropped silently? This likely overlaps the
   "wedged pipe" signature (send hangs / chat in bad condition). Needs the live
   broken chat + daemon.log to confirm; can't repro statically.

2. FEATURE - unsent message queue UI: if messages can be queued-but-undelivered,
   show them. Joe wants a collapsible section at the bottom of the chat listing
   every message he sent that has NOT yet been delivered to the AI, so nothing is
   silently lost. Needs a backend notion of "pending/undelivered" per message
   (does the daemon already track an outbox? if not, add one) surfaced to the
   frontend composer/transcript area.

## Status

Deferred by Joe ("later we can see what went wrong in this specific chat"). Start
with the diagnosis (piece 1) using the actual broken chat's daemon logs before
building the queue UI (piece 2).
