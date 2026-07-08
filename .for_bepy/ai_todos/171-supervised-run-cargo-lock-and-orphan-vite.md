# /supervised-run: handle the cargo-exe-lock dance and orphan vite for tauri dev entries

**Type:** skill-improvement

## Goal
Stop rediscovering two recurring failure modes when working on this repo (and any Tauri repo) under the supervisor: (1) `cargo build`/`cargo test` fails with "failed to remove claude-conductor.exe: Access is denied (os error 5)" while the supervised `cargo tauri dev` app runs; (2) a crashed `cargo-tauri` supervisor entry leaves an ORPHAN vite holding port 1420, which makes every subsequent restart crash with "Port 1420 is already in use".

## Context
Both hit repeatedly on 2026-07-08 (three stop/build/start cycles, two orphan-vite cleanups). The skill file `~/.claude/skills/supervised-run/SKILL.md` has a crash-cleanup step (read logs, restart or delete) but nothing about (a) stopping a supervised tauri-dev entry before running cargo builds/tests against the same target dir, or (b) checking for surviving `beforeDevCommand` children (vite) after a `cargo tauri dev` crash - the supervisor kills the tauri CLI process, not its npm/vite grandchildren.

## Approach
Edit `~/.claude/skills/supervised-run/SKILL.md`, adding to the Notes (or a new "Tauri dev entries" section):
- Before `cargo build`/`cargo test` in a repo whose supervised entry runs `cargo tauri dev`: stop the entry first (`POST /procs/<id>/stop`), build, then `POST /procs/<id>/start` - the dev app holds a lock on `target/debug/<app>.exe`.
- After any `cargo tauri dev` entry crash, before restarting: kill orphan vite (`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'vite' }`) and verify the dev port (1420 here) is free - the crashed tauri CLI leaves its beforeDevCommand vite alive.

## Acceptance
- The skill file contains both notes.
- Next session that builds while the dev app runs follows stop -> build -> start without hitting os error 5.
