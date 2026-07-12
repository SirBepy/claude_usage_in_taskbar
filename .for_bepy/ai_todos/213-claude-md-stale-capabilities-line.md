# 213 - CLAUDE.md's capabilities/default.json rule is stale

Type: docs

## Problem

`CLAUDE.md` states:

> New IPC command requires a matching entry in `src-tauri/capabilities/default.json` or it silently fails.

This is false. Verified 2026-07-10: `capabilities/default.json` has 25 entries and none of them are session commands. `start_session` and `open_chats_for_session` are both absent from it and both work. `generate_handler!` alone authorizes a Tauri command.

The claim already contradicts the project memory `project_custom_commands_no_capabilities_entry.md`, and it cost a subagent a detour during the rate-limit work.

## Fix

Correct or delete the line in `CLAUDE.md`. If the rule applies to some narrower category (plugin permissions, window labels: note `project_tauri_new_window_capabilities.md` says window LABELS genuinely do need an entry), say exactly which, rather than "new IPC command".

## Files

- `CLAUDE.md`
