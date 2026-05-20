# Chat reload re-appends synthetic user messages (duplicates)

**Severity:** low-medium (cosmetic, annoying; pre-existing, NOT a daemon-phase regression)

**Symptom:** Open a chat, send a few turns (my1/ai1/my2/ai2). Click to another chat and back. The pane shows the correct history (my1/ai1/my2/ai2) followed by the user messages AGAIN (my1/my2 re-appended at the bottom). Observed under daemon mode 2026-05-21 but Joe confirms it has happened "here and there in the past" → shared Path-C code path, not introduced by the daemon cutover.

**Root cause (likely):** The composer pushes a *synthetic* `user_message` into the event-store cache on send (`pending-pane.ts` `sessionEvents.pushSynthetic`, ~line 118) so the user sees their text immediately (claude `-p` never echoes the prompt). On reload, `event-store.ts::loadInitial` fetches history from JSONL and merges `liveAfterPage = entry.events.filter(ev => Number(ev.timestamp) > pageNewestTs)`. The synthetic user messages carry `BigInt(Date.now())` (ms epoch ≈ 1.7e12) while the history events' `timestamp` is parsed by `chat/parser.rs` from the JSONL `timestamp` field via `as_i64().unwrap_or(0)` — the JSONL timestamp is an ISO string, so it parses to **0**. So `pageNewestTs = 0` and the synthetic user messages always pass the `> 0` filter → re-appended → duplicated. (Verify this hypothesis: log `pageNewestTs` + the synthetic ts in `loadInitial`.)

**Fix options:**
- Make `parse_line` populate a real numeric `timestamp` from the JSONL ISO `timestamp` string (parse RFC3339 → millis) so the existing dedup filter works. Cleanest, fixes the root.
- OR on reload, drop synthetic `user_message`s from the live cache that the history page already covers (match by content/order rather than ts).
- OR bust the synthetic user messages from the cache when history loads.

**Out of scope for the daemon phases** — it's a frontend event-store/parser timestamp bug. Pick up after the daemon pivot lands, or whenever Joe wants the reload glitch gone.
