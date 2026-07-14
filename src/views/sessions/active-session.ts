import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import { ChatRenderer } from "../../shared/chat/chat-renderer";
import { sessionEvents } from "../../shared/chat/event-store";
import { showChatLoadingOverlay } from "../../shared/chat/chat-loading";
import { Composer } from "../../shared/chat/composer";
import { HeldMessages } from "../../shared/chat/held-messages";
import { ScheduledChip } from "../../shared/chat/scheduled-chip";
import { formatFireAt } from "../../shared/chat/schedule-picker";
import { blocksToText } from "../../shared/chat/content-blocks";
import { showToast } from "../../shared/toast";
import { setFileEditsProvider } from "../../shared/chat/file-viewer";
import { setPrReviewCwdProvider } from "../../shared/chat/pr-review-modal";
import type { ChatEvent, ContentBlock, Instance, ScheduledItem, ScheduledKind } from "../../types/ipc.generated";
import { state, setActiveSession } from "./state";
import { getSettings } from "../../shared/state";
import {
  projectName,
  sessionSubtitle,
  loadUnreadSet,
  saveUnreadSet,
  paneEmptyStateHtml,
  statusDotClass,
  deriveQuestionSet,
} from "./sessions-helpers";
import { SessionStatusbar, loadStatuslineRows, loadStatuslineHideZero } from "./session-statusbar";
import { readLastChoice, readPresets } from "../../shared/effort-presets";
import { renderSidebar, refreshSessions } from "./sidebar";
import { characterForSession, characterIconUrl, loadSessionCharacters } from "./session-characters";
import { hydrateCharacterAvatars, hydrateProjectTechIcons } from "../../shared/projects";
import { api } from "../../shared/api";
import { askConfirm } from "../../shared/confirm";
import { openChangeCharacterModal } from "../../shared/change-character-modal";
import { openChangeAccountModal } from "../../shared/change-account-modal";
import {
  addBackgroundSession,
  removeBackgroundSession,
  isAutoAccept,
  replayPendingPrompt,
  pendingPromptSessionIds,
} from "./permission-modal";
import { snapshotActiveCardDraft } from "./permission-modal/question-ui";
import { savePendingPromptDraft } from "./permission-modal/gating";
import { markSessionExiting } from "./sidebar-anim";
import { markSessionClosing, unmarkSessionClosing } from "./closing-sessions";
import { watchCloseLifecycle } from "./close-finalize";
import { ChangesPanel, dedupeByPath } from "./changes-panel";
import { SessionHeader } from "./session-header";
import { setThinkingActivity, setThinkingProgress, isCurrentSessionBusy, updateThinkingBar } from "./session-thinking-bar";
import { isBlocked, formatClockLabel, capitalize, getCachedAccount } from "../../shared/chat/rate-limit-banner";
import { openModelEffortModal } from "./model-effort-modal";
import { registerCta } from "../../shared/chat/cta-registry";
import { completeHandoff } from "./handoff";

const HEADER_STATUS_CLASSES = [
  "st-working", "st-question", "st-done", "st-your-turn", "st-external", "st-attention", "st-rate-limited",
];

/** Status class (st-working / st-question / …) for an open session, using the
 * same classifier the sidebar rows use so the header avatar's border colour
 * matches the sidebar strip. Exported for the live recolour on the
 * instances-changed event. */
export function headerStatusClass(sess: Instance): string {
  const unread = loadUnreadSet();
  // A prompt shown for the currently-viewed chat is parked so it survives a
  // switch-away, but its card is already on screen - don't also alarm its own
  // row. Backgrounded chats with parked prompts still badge.
  const attention = pendingPromptSessionIds();
  if (state.selectedId) attention.delete(state.selectedId);
  // Registry-backed only (see deriveQuestionSet): the same single source the
  // sidebar rows read, so header ring and row can never disagree.
  const question = deriveQuestionSet(state.sessions);
  const rateLimited = new Set(state.sessions.filter(isBlocked).map((s) => s.session_id));
  return statusDotClass(sess, unread, attention, question, rateLimited);
}

/** Swap the header avatar's status ring class without re-rendering the whole
 * header. Called from instances-changed so the border stays in sync with the
 * sidebar. */
export function updateHeaderAvatarStatus(pane: HTMLElement, sess: Instance): void {
  const heroEl = pane.querySelector<HTMLElement>(".session-header-avatar");
  if (!heroEl) return;
  const st = headerStatusClass(sess);
  if (heroEl.classList.contains(st)) return;
  heroEl.classList.remove(...HEADER_STATUS_CLASSES);
  heroEl.classList.add(st);
}

/**
 * Open the Change Character modal for a session and apply the pick: persist the
 * session->character mapping, reload the session-character cache, play the new
 * character's `select` sound (best-effort), and refresh the header face + the
 * sidebar row. Shared by the header face click and the ⋮ "Change character"
 * menu (the latter imports this dynamically to avoid an import cycle).
 */
export async function changeCharacterForSession(sessionId: string): Promise<void> {
  const sess = state.sessions.find((s) => s.session_id === sessionId);
  if (!sess) return;
  const current = characterForSession(sess);
  const picked = await openChangeCharacterModal({ projectId: sess.project_id, currentId: current });
  if (!picked || picked === current) return;
  try {
    await api.setSessionCharacter(sessionId, picked);
    await loadSessionCharacters();
    void api.playCharacterSlot(picked, "select").catch(() => { /* sound is best-effort */ });
  } catch (e) {
    console.error("[active-session] change character failed", e);
    return;
  }
  // Surgically swap the active pane's header face (avoid a full pane re-render
  // that would tear down the live renderer/composer mid-session).
  if (state.selectedId === sessionId) {
    const header = document.querySelector<HTMLElement>(".session-header");
    const old = header?.querySelector<HTMLElement>(".header-char-clickable");
    if (header && old) {
      const url = characterIconUrl(picked);
      const wrapper = document.createElement("span");
      wrapper.className = `session-header-avatar header-char-clickable ${headerStatusClass(sess)}`;
      wrapper.title = "Change character";
      wrapper.setAttribute("role", "button");
      wrapper.tabIndex = 0;
      const backdrop = document.createElement("img");
      backdrop.className = "char-avatar session-header-backdrop";
      backdrop.dataset.characterId = picked;
      backdrop.alt = "";
      backdrop.setAttribute("aria-hidden", "true");
      if (url) { backdrop.src = url; backdrop.dataset.hydrated = picked; }
      const sharp = document.createElement("img");
      sharp.className = "char-avatar session-header-char";
      sharp.dataset.characterId = picked;
      sharp.alt = "";
      if (url) { sharp.src = url; sharp.dataset.hydrated = picked; }
      wrapper.appendChild(backdrop);
      wrapper.appendChild(sharp);
      old.replaceWith(wrapper);
    }
  }
  const root = document.querySelector<HTMLElement>(".view-sessions");
  const listEl = root?.querySelector<HTMLElement>("#sessions-list");
  if (listEl) renderSidebar(listEl);
}

/**
 * Move a session to a different Claude account: opens the account picker,
 * forks the transcript onto a fresh session id under the picked account
 * (via `moveSessionToAccount`, the same mechanism the rate-limit banner's
 * "Continue on <Other>" button uses), then retires the old session.
 * Shared by the statusline account chip's click handler and the ⋮ "Change
 * account" menu item.
 */
export async function changeAccountForSession(sessionId: string): Promise<void> {
  const sess = state.sessions.find((s) => s.session_id === sessionId);
  if (!sess) return;
  const picked = await openChangeAccountModal({ currentId: sess.account_id ?? null, title: "Change account" });
  if (!picked || picked === sess.account_id) return;
  try {
    const newId = await api.moveSessionToAccount(sessionId, picked);
    const label = capitalize(getCachedAccount(picked)?.label ?? "the other account");
    showToast(`Moved to ${label}, continuing there.`);
    await refreshSessions();
    const root = document.querySelector<HTMLElement>(".view-sessions");
    const listEl = root?.querySelector<HTMLElement>("#sessions-list");
    if (listEl) renderSidebar(listEl);
    if (state.selectedId === sessionId) {
      const pane = root?.querySelector<HTMLElement>("#session-pane");
      if (pane) await selectSession(newId, pane);
    }
  } catch (e) {
    console.error("[active-session] change account failed", e);
    showToast("Failed to move chat to that account.");
  }
}

let _watchedId: string | null = null;

export function unwatchCurrentExternalSession(): void {
  if (_watchedId) {
    void invoke<void>("unwatch_session_transcript", { sessionId: _watchedId }).catch(() => {});
    sessionEvents.stopWatchListener(_watchedId);
    _watchedId = null;
  }
}

export function dismountActivePane(opts?: { rerenderSidebar?: boolean }): void {
  state.statusbar?.destroy();
  state.statusbar = null;
  state.renderer?.detach();
  state.renderer = null;
  state.composer?.destroy();
  state.composer = null;
  state.scheduledChip?.destroy();
  state.scheduledChip = null;
  state.changesPanel?.unmount();
  state.changesPanel = null;
  state.activeChatActions = null;
  setThinkingActivity(null);
  setActiveSession(null);
  const pane = document.querySelector<HTMLElement>(".session-pane #session-pane")
    ?? document.querySelector<HTMLElement>("#session-pane");
  if (pane) pane.innerHTML = paneEmptyStateHtml(state.daemonConnected, state.daemonSetupStalled);
  if (opts?.rerenderSidebar !== false) {
    const root = document.querySelector<HTMLElement>(".view-sessions");
    if (root) {
      const listEl = root.querySelector<HTMLElement>("#sessions-list");
      if (listEl) renderSidebar(listEl);
    }
  }
}

registerCta("pickup", {
  label: "Close & start new chat with /pickup",
  icon: "hand-fist",
  handler: async () => {
    const sess = state.sessions.find(s => s.session_id === state.selectedId);
    if (!sess) return;
    const project = { path: String(sess.cwd ?? ""), name: projectName(sess) };
    const config = await openModelEffortModal(project.path, project.name);
    if (!config) return;
    void state.composer?.sendText("/close");
    state.launchNewChatCallback?.(project, { ...config, initialMessage: "/pickup" });
  },
});

export async function selectSession(sessionId: string, pane: HTMLElement): Promise<void> {
  // Mobile single-pane: opening a chat reveals the chat pane (CSS only acts on
  // this attribute inside the ≤768px media query, so desktop is unaffected).
  // Set before the same-session early return so re-tapping the open chat from
  // the list overlay still switches away from the list.
  document.querySelector(".view-sessions")?.setAttribute("data-mobile-pane", "chat");
  if (state.selectedId === sessionId) return;
  // Snapshot any in-progress AUQ answer before the pane is replaced, so it
  // survives the session switch even if another session also gets an AUQ.
  if (state.selectedId) {
    const draft = snapshotActiveCardDraft(state.selectedId);
    if (draft) savePendingPromptDraft(state.selectedId, draft);
  }
  // Unwatch any previously watched session if we're switching to a different one.
  if (_watchedId && _watchedId !== sessionId) {
    void invoke<void>("unwatch_session_transcript", { sessionId: _watchedId }).catch(() => {});
    sessionEvents.stopWatchListener(_watchedId);
    _watchedId = null;
  }
  const myMount = state.mountId;
  setActiveSession(sessionId);

  // Mark session as read
  const unread = loadUnreadSet();
  if (unread.has(sessionId)) {
    unread.delete(sessionId);
    saveUnreadSet(unread);
  }

  // Clean up prior statusbar timer before wiping the pane.
  if (state.statusbar) {
    state.statusbar.destroy();
    state.statusbar = null;
  }

  const sess = state.sessions.find((s) => s.session_id === sessionId);
  if (!sess) {
    pane.innerHTML = `<div class="session-empty">Session ${escapeHtml(sessionId)} not found</div>`;
    return;
  }
  const readOnly = sess.kind === "external" || sess.kind === "automated";
  pane.classList.toggle("is-rate-limited", isBlocked(sess));
  const headerCharId = characterForSession(sess);
  const headerIconUrl = headerCharId ? characterIconUrl(headerCharId) : null;
  const headerStatus = headerStatusClass(sess);

  // Opt-in cue (Settings > Sound, default off): play the character's "select"
  // sound when a session row is clicked. Per-slot toggle + mute enforced in Rust.
  if (headerCharId && getSettings().selectOnSessionClick === true) {
    void api.playCharacterSlot(headerCharId, "select").catch(() => { /* best-effort */ });
  }

  const header = new SessionHeader({ title: sessionSubtitle(sess), meta: projectName(sess) });
  header.onCharClick = () => { void changeCharacterForSession(sess.session_id); };
  header.setRemote(sess.is_remote);
  header.bindSession({
    sessionId: sess.session_id,
    readOnly,
    charId: headerCharId,
    charUrl: headerIconUrl,
    charStatus: headerStatus,
    cwd: sess.cwd ? String(sess.cwd) : null,
    autoAcceptOn: !readOnly && isAutoAccept(sess.session_id),
  });

  pane.innerHTML = [
    `<div class="session-statusbar-host"></div>`,
    readOnly ? `<div class="readonly-banner"><i class="ph ph-eye"></i> <span class="readonly-banner-text">Read-only session</span><button type="button" class="refresh-btn" title="Reload messages"><i class="ph ph-arrows-clockwise"></i></button><button type="button" class="takeover-btn">Take Over</button></div>` : "",
    `<div class="session-messages"></div>`,
    `<div class="session-thinking" hidden><span class="thinking-text"></span><span class="held-chip-slot"></span><button class="thinking-pause-btn icon-btn" title="Stop turn" hidden><i class="ph ph-stop-circle"></i></button></div>`,
    `<div class="scheduled-chip-slot"></div>`,
    `<div class="session-composer"></div>`,
  ].join("");
  pane.insertBefore(header.el, pane.firstChild);

  // Stall guard (ai_todo 226): the awaits below normally settle in ms, but a
  // wedged backend (2026-07-11 incident) left this header floating over a
  // blank pane forever with no feedback. Ring only after 150ms so cache-hit
  // reopens don't flash; error + Retry if nothing settles within 8s.
  const messagesHost = pane.querySelector<HTMLElement>(".session-messages");
  let loadSettled = false;
  const ringTimer = window.setTimeout(() => {
    if (!loadSettled && messagesHost) showChatLoadingOverlay(messagesHost);
  }, 150);
  const stallTimer = window.setTimeout(() => {
    if (loadSettled || state.mountId !== myMount || state.selectedId !== sessionId) return;
    if (!messagesHost) return;
    // ai_todo 228 diagnostics: this guard times a purely local chain
    // (in-memory settings read + local transcript file read) - it is NOT
    // waiting on the daemon pipe. If this fires, the stall is in that local
    // chain (or an unhandled exception before it), not a pipe EOF.
    console.error(`[sessions] chat load stalled >8s (local settings/history read), session=${sessionId}`);
    messagesHost.querySelector(".chat-loading-overlay")?.remove();
    messagesHost.innerHTML =
      `<div class="session-empty session-empty--stalled chat-load-stalled">` +
      `<i class="ph ph-warning"></i>` +
      `<div>This chat isn't loading - the backend didn't respond.</div>` +
      `<button type="button" class="chat-load-retry">Retry</button>` +
      `</div>`;
    messagesHost.querySelector<HTMLButtonElement>(".chat-load-retry")?.addEventListener("click", () => {
      setActiveSession(null);
      void selectSession(sessionId, pane);
    });
  }, 8000);
  const settleLoad = () => {
    loadSettled = true;
    window.clearTimeout(ringTimer);
    window.clearTimeout(stallTimer);
    messagesHost?.querySelector(".chat-loading-overlay")?.remove();
  };

  pane.querySelector<HTMLButtonElement>(".thinking-pause-btn")?.addEventListener("click", () => {
    void invoke<void>("cancel_turn", { sessionId: sess.session_id }).catch(err => console.error("[sessions] cancel_turn failed", err));
  });

  if (headerCharId) void hydrateCharacterAvatars(pane);
  void hydrateProjectTechIcons(pane);

  // Mount statusbar.
  const sbHost = pane.querySelector<HTMLElement>(".session-statusbar-host");
  if (sbHost) {
    const rows = await loadStatuslineRows();
    const hideZero = await loadStatuslineHideZero();
    let effortDisplay = sess.effort ?? "";
    if (!effortDisplay && sess.kind === "external" && sess.cwd) {
      try {
        const settings = await invoke<Record<string, unknown>>("get_settings");
        const last = readLastChoice(settings, String(sess.cwd));
        const normal = readPresets(settings).find((p) => p.name === "Normal");
        effortDisplay = last?.effort ?? normal?.effort ?? "";
      } catch { /* leave blank */ }
    }
    const sb = new SessionStatusbar(sbHost, sess.started_at, rows, {
      cwd: sess.cwd ? String(sess.cwd) : null,
      effort: effortDisplay,
      sessionId: sess.session_id,
      readOnly: sess.kind === "external",
      sessionModel: sess.model || null,
      hideZero,
      accountId: sess.account_id ?? null,
      onAccountClick: () => { void changeAccountForSession(sess.session_id); },
    });
    state.statusbar = sb;
    // Git info is owned by the statusbar itself: it resolves the session's live
    // cwd (which may follow the AI into a worktree) via `session_live_cwd`, then
    // fetches against that. Fetching here too would race and clobber it with the
    // spawn-cwd branch.
  }

  // Attach renderer
  if (state.renderer) state.renderer.detach();
  state.changesPanel?.unmount();
  state.changesPanel = null;
  const messagesEl = pane.querySelector<HTMLElement>(".session-messages");
  if (messagesEl) {
    const renderer = new ChatRenderer(messagesEl);
    state.renderer = renderer;
    // Wire meta updates to statusbar (model, tokens, thinking, cost).
    const sbForRenderer = state.statusbar;
    if (sbForRenderer) {
      renderer.onMetaUpdate = (meta) => {
        if (state.statusbar === sbForRenderer) sbForRenderer.updateMeta(meta);
      };
      renderer.onToolTally = (t) => {
        if (state.statusbar === sbForRenderer) sbForRenderer.updateToolTally(t);
      };
      // Tool-chip popovers reuse the in-chat custom views (Read/File Changes/
      // Skills/Questions), built from this renderer's messages.
      sbForRenderer.setToolViewProvider((tool) => renderer.customToolView(tool));
      // Reopened chat: surface its already-accrued tool counts immediately.
      sbForRenderer.updateToolTally(renderer.toolTally);
    }
    // Mount the all-changes panel + wire renderer callbacks. Panel listens
    // for file mutations; activity feed routes to the thinking bar.
    const panel = new ChangesPanel();
    panel.mount(pane, messagesEl);
    state.changesPanel = panel;
    renderer.onFileEditsChanged = (edits) => {
      panel.onUpdate(edits);
      header.setChangesBadge(dedupeByPath(edits).length);
    };
    // Let the file viewer's Diff tab resolve this session's edits for any file.
    setFileEditsProvider(() => renderer.getFileEdits());
    // Let the PR-preview modal's git IPC calls (get_range_files/get_file_diff)
    // resolve this session's working directory.
    setPrReviewCwdProvider(() => (sess.cwd ? String(sess.cwd) : null));
    renderer.onActivityUpdate = (activity) => setThinkingActivity(activity);
    renderer.onProgressUpdate = (n, m) => setThinkingProgress(n, m);
    renderer.onNextAiPromptDone = () => {
      if (state.renderer !== renderer) return;
      renderer.injectCta("pickup");
    };
    renderer.onHandoffReady = () => {
      if (state.renderer !== renderer) return;
      if (state.selectedId !== sessionId) return;
      void completeHandoff(sessionId);
    };
    // NOTE: the sidebar/header question flag is NOT derived here anymore. The
    // renderer's marker detection only ever ran for the OPEN chat, so it went
    // stale the moment a session was backgrounded (a later turn's "done" never
    // cleared an old "question", and vice versa), and it fired on intermediate
    // markers mid-turn. The registry's `awaiting` (set by the daemon from the
    // result line, gen-guarded) is the single source of truth now - see
    // deriveQuestionSet in sessions-helpers.ts.
    header.onChangesClick = () => panel.toggle();
    // Expose the panel toggle through the state seam so view-more-menu and
    // sidebar-ctx-menu can offer "View changes" for the active session.
    state.activeChatActions = { viewChanges: () => panel.toggle() };
    await renderer.attach(sessionId);
    // Bail if a newer mount or selectSession superseded us during await.
    if (state.mountId !== myMount || state.selectedId !== sessionId) {
      settleLoad();
      renderer.detach();
      return;
    }
    // Pull from the shared event store. Cache hit = instant render with no
    // IPC. Cache miss triggers load_history_page under the hood (last 20
    // messages). Either way the store keeps the live `chat:<id>` listener
    // attached so events accrue even when this session isn't selected.
    const overlay = sessionEvents.isLoaded(sessionId) ? null : showChatLoadingOverlay(messagesEl);
    try {
      await renderer.loadFromStore(sess.cwd ? String(sess.cwd) : undefined);
      if (state.mountId !== myMount || state.selectedId !== sessionId) {
        settleLoad();
        renderer.detach();
        return;
      }
    } catch {
      /* tolerate absence */
    } finally {
      // Also clears the stall watchdog + 150ms ring timer.
      settleLoad();
      overlay?.remove();
    }
    // Self-heal against the lossy daemon->app notifier: a turn that completed
    // while this session was backgrounded may be missing from the cache even
    // though the sidebar marked it "done". Re-read the transcript tail and paint
    // anything the live channel dropped. Fire-and-forget so reopen stays instant;
    // recovered events arrive via the live subscriber path.
    void sessionEvents.reconcileLatest(sessionId, sess.cwd ? String(sess.cwd) : undefined);
    // Sync sidebar once after replay (no per-event re-renders fired during it).
    const rootEl = document.querySelector<HTMLElement>(".view-sessions");
    const listAfterLoad = rootEl?.querySelector<HTMLElement>("#sessions-list");
    if (listAfterLoad) renderSidebar(listAfterLoad);
  }

  // Attach composer + held-messages controller
  const composerEl = pane.querySelector<HTMLElement>(".session-composer");
  if (composerEl) {
    // The real send-to-daemon path. Shared by the composer (normal send) and
    // by the held-messages controller (flushing a bundled set as one message).
    const sendBundle = async (blocks: ContentBlock[]): Promise<void> => {
      // Optimistically push the user's message via the store; claude -p
      // doesn't echo it back via stream-json. Cache stays consistent.
      sessionEvents.pushSynthetic(sessionId, {
        type: "user_message",
        content: blocks,
        timestamp: BigInt(Date.now()),
      } as ChatEvent);

      // Watch this turn for the /close skill's own lifecycle markers - never
      // guess from the user's typed text (a "/close" substring anywhere in
      // the message, even inside unrelated prose, used to mark the row
      // "closing" before the skill had even started running). The row is
      // promoted to "closing" only once <cc-close:starting> confirms the
      // skill is genuinely running, and torn down only once <cc-close:done>
      // confirms Phase 6 is actually killing the terminal - a settled turn
      // without it (e.g. `/close --dont-close`) reverts the row to normal
      // instead of ripping the chat away. See close-finalize.ts.
      const cwd = String(sess.cwd ?? ".");
      let sawBusy = false;
      const cancelCloseWatch = watchCloseLifecycle({
        subscribe: (onEvent) => sessionEvents.subscribe(sessionId, onEvent),
        pollSettled: async () => {
          const all = await invoke<Instance[]>("list_instances");
          const inst = (all || []).find((i) => i.session_id === sessionId);
          if (!inst || inst.ended_at) return "settled"; // already gone / ended
          if (inst.busy) { sawBusy = true; return "running"; }
          // Not busy: settled once we've seen the turn run, or the daemon
          // recorded a turn verdict (awaiting). Otherwise we're still pre-start.
          return sawBusy || inst.awaiting ? "settled" : "running";
        },
        onStarting: () => {
          addBackgroundSession(sessionId);
          markSessionClosing(sessionId);
          const listEl = document.querySelector<HTMLElement>("#sessions-list");
          if (listEl) renderSidebar(listEl);
        },
        onStandDown: () => {
          removeBackgroundSession(sessionId);
          unmarkSessionClosing(sessionId);
          const listEl = document.querySelector<HTMLElement>("#sessions-list");
          if (listEl) renderSidebar(listEl);
        },
        finalize: () => {
          removeBackgroundSession(sessionId);
          unmarkSessionClosing(sessionId);
          const exitListEl = document.querySelector<HTMLElement>("#sessions-list");
          if (exitListEl) markSessionExiting(exitListEl, sessionId);
          invoke<void>("clear_session", { sessionId })
            .catch(() => {})
            .finally(() => {
              if (state.selectedId === sessionId) {
                dismountActivePane({ rerenderSidebar: true });
              } else {
                const el = document.querySelector<HTMLElement>("#sessions-list");
                if (el) renderSidebar(el);
              }
            });
        },
      });

      try {
        await invoke<void>("send_message", { sessionId, cwd, blocks });
      } catch (err) {
        console.error("[sessions] send_message failed", err);
        cancelCloseWatch();
        alert(`Send failed: ${err}`);
      }
    };

    state.composer?.destroy();
    const composer = new Composer(composerEl, {
      projectDir: sess.cwd ?? null,
      getRenderer: () => state.renderer,
      onSend: sendBundle,
      // While busy, Enter stages instead of sends; when not busy but a held set
      // exists, a normal send bundles it with the draft as one message.
      isBusy: () => isCurrentSessionBusy(),
      isBlocked: () => {
        const inst = state.sessions.find((s) => s.session_id === sessionId);
        if (!inst || !isBlocked(inst)) return null;
        const resetsAtMs = Number(inst.rate_limited_resets_at) * 1000;
        const delayedMs = resetsAtMs + 60_000;
        const accLabel = capitalize(getCachedAccount(inst.account_id)?.label ?? "This account");
        return {
          resetsAtIso: new Date(delayedMs).toISOString(),
          resetsAtLabel: formatClockLabel(delayedMs),
          placeholder: `${accLabel} is out of usage until ${formatClockLabel(resetsAtMs)}. Your message will be sent when it resets.`,
        };
      },
      onStage: (blocks) => state.heldMessages?.stage(blocks),
      hasHeld: () => !!state.heldMessages?.hasItemsForActive(),
      flushHeldWithDraft: (draftBlocks) => { void state.heldMessages?.flushHeldWithDraft(draftBlocks); },
      onDraftActivity: () => state.heldMessages?.notifyDraftActivity(),
      getNextTokenReset: async () => {
        if (!sess.account_id) return null;
        const map = await api.getUsageMap();
        const resetsAt = map[sess.account_id]?.session_resets_at;
        return resetsAt ? new Date(new Date(resetsAt).getTime() + 60_000) : null;
      },
      onSchedule: (blocks, fireAtUtcIso, recurrence) => {
        const prompt = blocksToText(blocks);
        if (!prompt.trim()) return;
        const kind: ScheduledKind = { type: "message", session_id: sess.session_id, cwd: String(sess.cwd ?? ".") };
        void invoke<ScheduledItem>("schedule_create", { kind, prompt, fireAt: fireAtUtcIso, recurrence })
          .then((item) => {
            showToast(`Scheduled for ${formatFireAt(item.fire_at)}`);
            void state.scheduledChip?.refresh();
          })
          .catch((err) => {
            console.error("[sessions] schedule_create failed", err);
            showToast(`Failed to schedule: ${err}`);
          });
      },
    });
    state.composer = composer;
    composer.setSessionId(sessionId, { readOnly });

    state.scheduledChip?.destroy();
    const scheduledChipSlot = pane.querySelector<HTMLElement>(".scheduled-chip-slot");
    state.scheduledChip = scheduledChipSlot ? new ScheduledChip({ root: scheduledChipSlot, sessionId }) : null;
    if (state.renderer) {
      state.renderer.onSendText = (text) => { void sendBundle([{ type: "text", text }]); };
    }

    // Held-messages controller is a singleton (its per-session set survives
    // session switches); re-attach it to this freshly-mounted pane + session.
    if (!state.heldMessages) state.heldMessages = new HeldMessages();
    const thinkingBar = pane.querySelector<HTMLElement>(".session-thinking");
    const chipSlot = pane.querySelector<HTMLElement>(".held-chip-slot");
    if (thinkingBar && chipSlot) {
      state.heldMessages.attach({
        sessionId,
        chipSlot,
        anchor: thinkingBar,
        send: sendBundle,
        interrupt: () => invoke<void>("cancel_turn", { sessionId }),
        getDraftBlocks: () => composer.getDraftBlocks(),
        isDraftEmpty: () => composer.isDraftEmpty(),
        isComposing: () => composer.isComposing(),
        clearComposer: () => composer.clearComposer(),
        getIsBusy: () => isCurrentSessionBusy(),
        onChange: () => updateThinkingBar(),
      });
      // Switching back to a chat that already finished while it wasn't
      // selected shouldn't require an unrelated instances-changed event to
      // notice the held set is flushable — check right away.
      if (!isCurrentSessionBusy() && state.heldMessages.hasItemsForActive()) {
        const freshSess = state.sessions.find((s) => s.session_id === sessionId);
        const isQuestion = freshSess?.awaiting === "question";
        state.heldMessages.onCompletion(sessionId, isQuestion);
      }
    }
    updateThinkingBar();
  }

  // Start real-time file watcher for all sessions. External sessions get new
  // messages this way; Interactive sessions also need it so that turns
  // continued in a terminal appear in the UI. Watcher emits chat-watch:<id>
  // events; the store's ensureWatchListener deduplicates against runner events.
  _watchedId = sessionId;
  void invoke<void>("watch_session_transcript", { sessionId, cwd: sess.cwd ?? null })
    .then(() => sessionEvents.ensureWatchListener(sessionId))
    .catch((err) => console.warn("[sessions] watch_session_transcript failed:", err));

  if (readOnly) {
    pane.querySelector<HTMLButtonElement>(".refresh-btn")?.addEventListener("click", async () => {
      sessionEvents.bust(sessionId);
      // Clear selectedId so selectSession doesn't bail on the equality check.
      setActiveSession(null);
      await selectSession(sessionId, pane);
    });
    pane.querySelector<HTMLButtonElement>(".takeover-btn")?.addEventListener("click", async () => {
      const ok = await askConfirm(
        `Take over manual session? This kills the external claude process (pid ${sess.pid}) so this app can resume the session.`,
        { confirmLabel: "Take over" },
      );
      if (!ok) return;
      // The manual session was started outside this app, so there is no
      // account already on record for it - ask which one future turns
      // (--resume calls) should run under, instead of silently falling back
      // to the app's default account.
      const accountId = await openChangeAccountModal({ currentId: null, title: "Take over as which account?" });
      if (!accountId) return;
      try {
        const newId = await invoke<string>("takeover_manual", { manualPid: sess.pid, accountId });
        if (newId) {
          await refreshSessions();
          const root = document.querySelector<HTMLElement>(".view-sessions");
          if (root) {
            const listEl = root.querySelector<HTMLElement>("#sessions-list");
            if (listEl) renderSidebar(listEl);
          }
          await selectSession(newId, pane);
        }
      } catch (err) {
        console.error("[sessions] takeover_manual failed", err);
        alert(`Takeover failed: ${err}`);
      }
    });
  }

  // Re-render sidebar to mark active row.
  const root = document.querySelector<HTMLElement>(".view-sessions");
  if (root) {
    const listEl = root.querySelector<HTMLElement>("#sessions-list");
    if (listEl) renderSidebar(listEl);
  }

  // If this chat parked a permission/question prompt while it was in the
  // background, surface it now that the pane (and composer anchor) is mounted.
  replayPendingPrompt(sessionId);
}

