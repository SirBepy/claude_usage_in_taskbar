# Send streaming text deltas on the wire instead of full accumulated snapshots

**Type:** task

## Goal

Make per-chunk streaming cost O(delta) end-to-end. Today every `content_block_delta` still clones and re-serializes the FULL accumulated text through daemon -> RPC -> Tauri IPC / remote WS; commit c54a1ffd only reduced the frequency (100ms coalescing), not the per-emit size.

## Context

From the 2026-07-09 performance audit. `src-tauri/src/chat/parser.rs:111-122` accumulates `current_text` and clones the whole string into each `ChatEvent`. Coalescing (daemon pump in `src-tauri/src/daemon/lifecycle.rs`) capped emits at ~10/s, so remaining waste is ~O(n) per emit for huge responses - real but modest. Deferred because the event shape is load-bearing: the frontend event-store dedups two live sources (daemon stream + transcript-file watcher) CONTENT-based (see memory: chat two live sources, ts=0), and idempotent full-snapshot events are what make replay/dedup safe. A delta protocol must not break that.

## Approach

- Add a new event variant (e.g. `assistant_delta { message_id, block, seq, text }`) alongside the existing snapshot event; keep snapshots for turn-final/watcher/replay paths so dedup semantics stay content-based on COMPLETE messages only.
- Frontend accumulates deltas into the store entry; on any snapshot for the same message it reconciles (snapshot wins).
- Remote PWA transport (`src/shared/http-transport.ts` WS path) and the phone client must handle the new variant - same accumulate logic, shared code.
- Bump/verify daemon<->app RPC compatibility (old app + new daemon can coexist across an update; gate on a capability flag in the hello/init exchange if needed).
- Rejected: replacing snapshots entirely with deltas - breaks watcher dedup and mid-stream attach (a client attaching mid-turn needs a snapshot to start from; keep emitting one snapshot on attach).

## Acceptance

- Streaming a very long code-heavy response shows flat per-chunk IPC payload sizes (log frame sizes in dev).
- Mid-turn attach (open the chats window while a turn streams), detached window, and phone client all render identical transcripts to before.
- Watcher-vs-stream dedup vitest suites stay green; no duplicated or lost text at turn end.
