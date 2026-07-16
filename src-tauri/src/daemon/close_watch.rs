//! Daemon-side `/close` teardown detector.
//!
//! The `/close` skill emits two sentinels in its assistant text:
//! `<cc-close:starting>` (first line of skill output) and `<cc-close:done>`
//! (right before Phase 6 kills the terminal, and ONLY when the close really
//! proceeds - never on `--dont-close` or a failed chained command).
//!
//! Historically only the webview watched these markers (close-finalize.ts) and
//! called `clear_session` when the turn settled - so an app reload, webview
//! crash, or window close between the marker streaming in and the IPC call
//! meant the session was never marked ended, got persisted as live, and
//! resurrected into the sidebar on the next start. The daemon pump now runs
//! this watcher over the same assistant text so teardown survives any frontend
//! loss. The frontend watcher stays for the "closing" red-flag UX and as a
//! second finalize (mark_ended is idempotent).
//!
//! Both markers must appear, in order, within the SAME turn: `observe_text`
//! arms on `starting`, confirms on `done`, and the pump calls `reset()` at
//! every turn boundary that did not confirm - so a stray `<cc-close:done>` in
//! ordinary conversation (e.g. discussing these markers) can't combine with a
//! `starting` from an earlier turn.

#[derive(Debug, Default)]
pub struct CloseWatch {
    starting_seen: bool,
    done_seen: bool,
    /// `<cc-close:done>` seen regardless of whether `starting` preceded it.
    /// Only trusted when the caller has independent evidence this turn is a
    /// real /close run (the user's typed prompt started with `/close`) - see
    /// `close_confirmed_with_hint`. Covers the model skipping/mangling the
    /// first-line `starting` marker, which otherwise silently disarmed the
    /// whole daemon-side teardown.
    done_seen_raw: bool,
}

impl CloseWatch {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one assistant text snapshot. Streaming snapshots are cumulative
    /// (the parser re-emits the full accumulated block text), so a plain
    /// substring check is enough - no cross-chunk reassembly needed.
    pub fn observe_text(&mut self, text: &str) {
        // Cheap gate before lowercasing potentially long replies.
        if !text.contains('<') {
            return;
        }
        let lower = text.to_lowercase();
        if !lower.contains("<cc-close:") {
            return;
        }
        if lower.contains("<cc-close:starting>") {
            self.starting_seen = true;
        }
        if lower.contains("<cc-close:done>") {
            self.done_seen_raw = true;
            if self.starting_seen {
                self.done_seen = true;
            }
        }
    }

    /// True once `<cc-close:starting>` was seen this turn (the skill is
    /// genuinely running). Drives the daemon-authoritative `Instance.closing`
    /// flag so every window's sidebar can render "Closing".
    pub fn armed(&self) -> bool {
        self.starting_seen
    }

    /// True once both sentinels were seen in order within the current turn.
    pub fn close_confirmed(&self) -> bool {
        self.starting_seen && self.done_seen
    }

    /// Like [`close_confirmed`], but when `user_typed_close` is true (the
    /// turn's prompt literally started with `/close`) a `<cc-close:done>`
    /// alone is enough - the ordered-pair rule exists only to stop stray
    /// `done` markers in ordinary prose from killing a session, and a turn
    /// the user explicitly opened with `/close` is not ordinary prose.
    pub fn close_confirmed_with_hint(&self, user_typed_close: bool) -> bool {
        self.close_confirmed() || (user_typed_close && self.done_seen_raw)
    }

    /// Turn boundary without a confirmed close (e.g. `--dont-close` stand-down,
    /// or an unrelated turn): forget everything.
    pub fn reset(&mut self) {
        self.starting_seen = false;
        self.done_seen = false;
        self.done_seen_raw = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confirms_on_starting_then_done() {
        let mut w = CloseWatch::new();
        w.observe_text("<cc-close:starting>\nRunning the close skill now.");
        assert!(!w.close_confirmed(), "starting alone must not confirm");
        w.observe_text("Retro written. <cc-close:done>");
        assert!(w.close_confirmed());
    }

    #[test]
    fn done_without_starting_is_ignored() {
        let mut w = CloseWatch::new();
        w.observe_text("the skill emits <cc-close:done> before killing the terminal");
        assert!(!w.close_confirmed());
    }

    #[test]
    fn both_markers_in_one_snapshot_confirm() {
        // Cumulative streaming snapshots can carry both by the end of the block.
        let mut w = CloseWatch::new();
        w.observe_text("<cc-close:starting>\n...phases...\n<cc-close:done>");
        assert!(w.close_confirmed());
    }

    #[test]
    fn reset_at_turn_boundary_disarms() {
        let mut w = CloseWatch::new();
        w.observe_text("<cc-close:starting> running with --dont-close");
        w.reset(); // turn settled without done
        w.observe_text("later turn mentions <cc-close:done> in prose");
        assert!(!w.close_confirmed(), "starting must not survive a turn boundary");
    }

    #[test]
    fn case_insensitive_markers() {
        let mut w = CloseWatch::new();
        w.observe_text("<CC-CLOSE:STARTING>");
        w.observe_text("<Cc-Close:Done>");
        assert!(w.close_confirmed());
    }

    #[test]
    fn plain_text_is_a_noop() {
        let mut w = CloseWatch::new();
        w.observe_text("just a normal reply about closing files");
        assert!(!w.close_confirmed());
    }

    #[test]
    fn armed_tracks_starting_only() {
        let mut w = CloseWatch::new();
        assert!(!w.armed());
        w.observe_text("<cc-close:starting>");
        assert!(w.armed());
        w.reset();
        assert!(!w.armed());
    }

    #[test]
    fn hint_confirms_done_without_starting() {
        // Model forgot the first-line starting marker, but the user literally
        // typed /close: done alone must still confirm.
        let mut w = CloseWatch::new();
        w.observe_text("Retro written. <cc-close:done>");
        assert!(!w.close_confirmed(), "no hint, no starting: must not confirm");
        assert!(w.close_confirmed_with_hint(true));
        assert!(!w.close_confirmed_with_hint(false));
    }

    #[test]
    fn hint_without_done_never_confirms() {
        let mut w = CloseWatch::new();
        w.observe_text("<cc-close:starting> running with --dont-close");
        assert!(!w.close_confirmed_with_hint(true), "hint + starting alone must not confirm");
    }

    #[test]
    fn reset_clears_raw_done_too() {
        let mut w = CloseWatch::new();
        w.observe_text("prose mentioning <cc-close:done>");
        w.reset();
        assert!(!w.close_confirmed_with_hint(true), "raw done must not survive a turn boundary");
    }
}
