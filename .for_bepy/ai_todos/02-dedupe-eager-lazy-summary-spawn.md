# Dedupe eager + lazy news-summary claude spawns

## Goal
Avoid spawning two `claude` processes for the same news post when the background eager backfill and the on-open lazy path race. Currently if you open a brand-new post while the poll-loop backfill is mid-generation for it, both generate it (double subscription-quota spend, last write wins).

## Context
Two call sites run `news::summarizer::generate_for_slug`:
- `src-tauri/src/news/scheduler.rs` `spawn_ai_backfill` (eager, background, emit=false) - fires for genuinely-new slugs on poll/refresh.
- `src-tauri/src/ipc/news.rs` `generate_news_summary` (lazy/regenerate, emit=true) - fires when the frontend opens a post with no `aiSummary`.
Only overlaps in the narrow window where the user opens a new post during the ~15-40s backfill. Old posts never eager-generate, so they never double. Low frequency, but real waste.

## Approach
Add a shared in-flight guard in the backend (e.g. an `Arc<Mutex<HashSet<String>>>` or `tokio::sync` map in `AppState`/daemon state) keyed by slug. `generate_for_slug` (or a wrapper) checks-and-inserts before spawning; if the slug is already in flight, the second caller should **await the first's result** rather than spawn a second claude. The IPC path must still return the final `NewsPost` and stream to the user - so the coordination needs the waiter to receive the same deltas/result (e.g. broadcast channel per slug, or the IPC path subscribes to the backfill's `news-summary-*` events for that slug and returns once the store has the summary). Simplest acceptable v1: IPC path, on finding the slug already in flight, polls the store every ~500ms until `aiSummary` is set (or timeout), then returns it - no second spawn, no streaming for that one case.

## Acceptance
- Opening a post mid-backfill does not spawn a second `claude` (verify via process count / logs).
- The opened post still ends up showing the summary (either streamed or filled in when the backfill saves).
- No regression to the normal (no-overlap) lazy and eager paths.
