# Token source tracker: app chat vs CLI

## Goal
Build a comparison view that shows tokens/turns/messages spent per source (in-app chat vs CLI sessions) so Joe can verify whether the app burns more context than the CLI for equivalent work.

## Context
Joe's hypothesis: in-app Claude Conductor chats burn more tokens than CLI sessions because of MEMORY.md injection + system-reminder overhead. The data already exists in `instance_token_stats` IPC. The missing piece is a per-source breakdown (source = `Interactive` CLI vs app-hosted daemon chats) so the claim is verifiable rather than just felt.

## Approach
- Add a source dimension to the token stats view (Project Detail > Chats or a new Dashboard card).
- Source is derivable from session metadata: app-hosted chats have a `session_id` in the daemon's chat store; CLI sessions show up as `Interactive` in the instance_token_stats breakdown.
- Show per-source: total input tokens, output tokens, cache read tokens, turns, messages, and avg tokens/turn.
- A simple table or side-by-side bar chart is enough for v1. No new IPC needed if instance_token_stats already breaks down by session type.

## Acceptance
- Dashboard or Project Detail shows a breakdown with at least two rows: "In-app chat" vs "CLI / Interactive".
- Avg tokens/turn is visible so single-turn vs multi-turn sessions are comparable.
- No regression to existing stats views.
