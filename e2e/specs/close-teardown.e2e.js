// BILLED UI regression for ai_todo 147: `/close` tears the chat down.
//
// This spec used to drive the OLD marker-based lifecycle: it asserted the
// sidebar row promoted to "closing" on the skill's own `<cc-close:starting>`
// text sentinel and tore down on `<cc-close:done>` (see the removed
// close-finalize.ts / chat-classifiers.ts detectCloseStartToken /
// detectCloseDoneToken). That mechanism is gone.
//
// The daemon is now authoritative for the close lifecycle: it sets
// `Instance.closing` itself the moment a `/close` turn starts (broadcast via
// the existing `instances_changed` notifier, which the sidebar already reads
// - see sidebar.ts), and tears the session down (mark_ended + kill process)
// on an explicit signal. This spec needs to be rewritten against that
// daemon-driven behavior once the daemon-side signal shape lands.
//
// Skipped until then so it doesn't assert removed behavior.
describe.skip("/close teardown (ai_todo 147, daemon-authoritative - needs rewrite)", () => {
  it("needs a rewrite against the daemon-driven Instance.closing flag + explicit teardown signal", () => {
    // Intentionally left unimplemented - see comment above.
  });
});
