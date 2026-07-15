# Expose scheduling to remote (needs Joe's explicit ruling)

Type: Feature (blocked on a security-judgment decision)

## Why this is parked, not done

The scheduled-message chip (`src/shared/chat/scheduled-chip.ts`) does NOT render on remote
(HttpTransport) at all today. Two reasons, found while implementing the pencil-edit feature
(commit 71404f55):

1. `schedule_list` is a Tauri-only command that reads the schedule file directly
   (`src-tauri/src/ipc/schedule.rs`, and its own doc comment says it is deliberately NOT a
   daemon RPC). So on remote `ScheduledChip.refresh()` throws, is caught, `items = []`, and
   the chip never appears.
2. `src/shared/http-transport.ts` has NO case for any `schedule_*` command
   (`schedule_list`/`schedule_create`/`schedule_update`/`schedule_delete`/`schedule_fire_now`).

So the new "edit a scheduled message" pencil (commit 71404f55) works on DESKTOP only. On
remote there is nothing to edit because scheduling UI is absent there.

## The decision Joe must make (this is why it is parked)

Our converged iterate-it plan (the remote-parity design) explicitly flagged `schedule_*` as
"needs-judgment": exposing them to remote means a REMOTE client can create / delete / fire
UNATTENDED agent runs over the tailnet. That is a real remote-RPC attack surface expansion,
not a mechanical route add. Autopilot did not auto-expose it.

Two questions for Joe:
- Should remote be able to SEE scheduled items (read-only `schedule_list`)? Low risk, high value
  (the chip would then render + the pencil-edit would work on remote).
- Should remote be able to CREATE / DELETE / FIRE schedules (`schedule_create`/`_delete`/
  `_fire_now`)? Higher risk (remote-triggered unattended runs). Joe rules yes/no per command.

## Proposed fix (once Joe rules)

Read-only tranche (if approved):
- Add a `schedule_list` daemon RPC (`src-tauri/src/daemon/methods/schedule.rs`) that reads the
  same schedule file the Tauri command reads.
- Add it to `SAFE_METHODS` (`src-tauri/src/daemon/remote_handlers.rs`) with a justification comment.
- Add a `case "schedule_list"` in `http-transport.ts`.
- The chip then renders on remote and the pencil-edit (already built) works there too, EXCEPT
  the edit's `schedule_delete` step also needs routing (see below).

Mutator tranche (only the commands Joe approves):
- Route each approved `schedule_*` mutator the same way (daemon RPC if missing + SAFE_METHODS +
  http-transport case). `schedule_delete` is required for the pencil-edit to fully work on remote
  (edit = repopulate composer + delete the pending item).
- Add allowlist + dispatch unit tests mirroring the existing `*_dispatches_to_registered_handler`
  pattern in `src-tauri/src/daemon/methods/mod.rs`.

## Verify
- `cargo test --lib --manifest-path src-tauri/Cargo.toml`, `cargo build`, `pnpm tsc --noEmit`.
- Live: on remote, open a chat with a pending scheduled message, confirm the chip renders and
  the pencil repopulates the composer + removes the item.
