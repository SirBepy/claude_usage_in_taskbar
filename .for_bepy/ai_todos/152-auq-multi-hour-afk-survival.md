# AUQ multi-hour AFK survival - decide via soak test before any redesign

## Goal

Let an AskUserQuestion (AUQ) card be answered after the dev has been AFK for *several hours*, not just the ~1h the Tier-1 timeout fix now covers. This is the deferred half of the /iterate-it convergence on 2026-07-01 (Tier 1, the timeout-alignment fix, already shipped).

## The one fact that gates everything (do this FIRST - it is a physical soak test, likely a BEPY_TODO)

Nobody has verified whether a blocked `claude -p` process + its blocking `curl` hook actually survive a real multi-hour AFK. The single most likely real-world failure mode: a laptop that **sleeps** during AFK drops the TCP socket the blocked curl is holding open - no timeout bump fixes that. Run the soak test before building anything:

- Spawn a session, trigger an AskUserQuestion, put the machine into normal "Joe walked away" conditions (screen off / sleep) for 60-90 min, then answer.
- Observe: is the blocked curl/`claude -p` process still alive and does the answer still land?

The result forks the whole design:
- **If the process survives sleep:** keep-alive is viable; just raising the already-shipped `PROMPT_TIMEOUT` (hooks_server/permission.rs) + the curl `--max-time` + the hook `timeout` field (claude_config.rs) to a multi-hour value may be the entire fix. Cheap.
- **If sleep kills the connection (likely):** keep-alive fundamentally cannot do multi-hour AFK. Then either (a) issue a Windows power-request (`SetThreadExecutionState` / `PowerCreateRequest`) to prevent sleep *while a prompt is pending*, or (b) revisit the resume-based redesign - but now justified by THIS new fact, not the old "cold resume reads wrong" objection.

## Rejected in the /iterate-it (do NOT re-propose without new information)

- **Cold `--resume`-as-new-turn as the primary path.** Two skeptic rounds flagged the load-bearing risk: a synthetic "here is the answer" user message on a freshly-resumed process may not read as the answer to the just-asked question (it arrives with no live tool-call to attach to), and it trades a live in-memory reasoning context for a cold transcript reload. Only revisit if the soak test proves keep-alive impossible AND a power-request can't hold sleep off.
- **Persisting `pending_prompts` to disk under a keep-alive design.** Confirmed inert: the `oneshot::Sender` (state.rs:25) is a live in-process handle, not serializable. `add_prompt` only stores the notification payload (state.rs:118-123). A re-hydrated card after a daemon restart would answer into a 404 - `respond_question` looks up the id in a fresh empty `pending` map and returns `-32004 unknown request_id` (methods/permission.rs:65-71). Persistence only helps the resume approach, which is separately rejected above.

## Acceptance

- The soak-test fact is recorded (does a blocked AUQ survive real sleep-AFK?).
- A decision is made and implemented for the surviving branch (raise the window, add a power-request, or - only if forced by the fact - a scoped resume path).
- Whatever ships is verified against a real multi-hour AFK, not just a unit test.

## Related

- Tier 1 (shipped 2026-07-01): `tokio::time::timeout(PROMPT_TIMEOUT=3600s)` on the three un-timed `rx.await` in `src-tauri/src/daemon/hooks_server/permission.rs` + `"timeout": 3660` on the PreToolUse hook in `src-tauri/src/daemon/claude_config.rs`. That closed the actual known bug (unbounded wait silently capped at Claude Code's 600s hook default) and made the ~1h window real.
- Memories: `project_askuserquestion_relay_pretooluse_hook`, `project_auq_never_auto_dismiss`, `project_daemon_notifier_broadcast_lossy`.
