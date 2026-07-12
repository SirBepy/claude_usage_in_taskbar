import "./styles/tokens.css";
// Kit settings layer (neutral --color-* + .kit-* widget CSS) + the 4 palettes
// (2D [data-theme][data-mode]). Imported BEFORE base.css/widgets.css so
// claude_usage's own base element rules (e.g. body font) win over the kit reset.
import "../vendor/tauri_kit/frontend/settings/styles.css";
import "../vendor/tauri_kit/frontend/settings/palettes/sirbepy-default.css";
import "./styles/base.css";
import "./styles/widgets.css";

import { mountRouter, registerView } from "./router";
import { renderDashboard } from "./views/dashboard/dashboard";
import { renderSessionsView, renderDetachedSession, queueSessionSelect, queueNewChat } from "./views/sessions/sessions";
import { renderHistoryView, queueHistorySelect } from "./views/history/history";
import { renderScheduleView } from "./views/schedule/schedule";
import { renderProjectsView } from "./views/projects/projects";
import { renderCharactersView } from "./views/characters/characters";
import { renderCharacterDetailView } from "./views/characters/character-detail";
import { renderNewsView } from "./views/news/news";
import { renderProjectDetailView } from "./views/project-detail/project-detail";
import { renderCharacterPickView } from "./views/project-detail/subviews/character-pick/character-pick";
import { renderAutomationView } from "./views/project-detail/subviews/automation/automation";
import { renderFolderMappingView } from "./views/project-detail/subviews/folder-mapping/folder-mapping";
import { renderSessionsListView } from "./views/project-detail/subviews/sessions-list/sessions-list";
import { renderSessionDetailView } from "./views/session-detail/session-detail";
import { renderSettingsView } from "./views/settings/settings";
import { renderSkillDetailView } from "./views/skill-detail/skill-detail";
import { renderSkillsView } from "./views/skills/skills";
import { renderAppearanceView } from "./views/settings/subviews/appearance/appearance";
import { renderNotificationsView } from "./views/settings/subviews/notifications/notifications";
import { renderChatDefaultsView } from "./views/settings/subviews/chat-defaults/chat-defaults";
import { renderCharactersSettingsView } from "./views/settings/subviews/characters/characters";
import { renderSystemView } from "./views/settings/subviews/system/system";
import { renderPermissionsView } from "./views/settings/subviews/permissions/permissions";
import { renderStatuslineView } from "./views/settings/subviews/statusline/statusline";
import { renderAboutView } from "./views/settings/subviews/about/about";
import { renderRemoteAccessView } from "./views/settings/subviews/remote-access/remote-access";
import { renderAccountsSettingsView } from "./views/settings/subviews/accounts/accounts";
import { initBoot } from "./shared/boot";
import { ensureRemoteToken } from "./shared/remote-gate";
import { isRemote } from "./shared/transport";
import { showView } from "./shared/navigation";
import { closeSidemenu } from "./shared/sidemenu";
import { initBackButton, registerOverlayBack } from "./shared/back-button";
import { installPermissionModalListener, setSidebarRerenderHook, setSelectedSessionId } from "./views/sessions/permission-modal";
import { renderSidebar } from "./views/sessions/sidebar";
import { installExternalLinkInterceptor } from "./shared/external-links";
import { invoke } from "./shared/ipc";
import { sessionEvents } from "./shared/chat/event-store";
import { openModelEffortModal } from "./views/sessions/model-effort-modal";
import { askConfirm } from "./shared/confirm";
import type { ChatEvent, NewsPost, ScheduledItem } from "./types/ipc.generated";

// Test seam (ai_todo 53 e2e): in dev only, expose a helper that injects a
// synthetic file-edit tool_use into a mounted session so the wdio harness can
// exercise the inline edit-window + changes panel + activity bar WITHOUT a real
// (billed) claude turn. `import.meta.env.DEV` is true under the vite dev server
// the e2e harness loads; `vite build` strips this block from production bundles.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__injectEdit = (
    sessionId: string,
    opts: { tool: string; file: string; oldText?: string; newText?: string; content?: string }
  ): void => {
    const input =
      opts.tool === "Write"
        ? { file_path: opts.file, content: opts.content ?? opts.newText ?? "" }
        : { file_path: opts.file, old_string: opts.oldText ?? "", new_string: opts.newText ?? "" };
    const ev: ChatEvent = {
      type: "tool_use",
      tool_name: opts.tool,
      input,
      id: `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: BigInt(Date.now()),
      parent_tool_use_id: null,
    };
    sessionEvents.pushSynthetic(sessionId, ev);
  };

  // News e2e seam: inject synthetic posts into the news view so the wdio harness
  // can exercise the kebab menu + detail view + cached-summary render WITHOUT a
  // real (billed) claude summary call. The news view listens for this event.
  (window as unknown as Record<string, unknown>).__injectNews = (posts: unknown): void => {
    window.dispatchEvent(new CustomEvent("e2e-inject-news", { detail: posts }));
  };

  // AskUserQuestion e2e seam (ai_todo 16): exercise the question-card relay's
  // FRONTEND hop (Tauri `question-requested` event -> installed listener -> gate
  // -> showQuestionCard) WITHOUT a real claude turn or the daemon. `__injectQuestion`
  // emits the real Tauri event so the actual listener + gate fire; `__setSelectedSession`
  // primes the gate's selected id so a matching question is not parked.
  (window as unknown as Record<string, unknown>).__setSelectedSession = (id: string | null): void => {
    setSelectedSessionId(id);
  };
  (window as unknown as Record<string, unknown>).__injectQuestion = (payload: unknown): void => {
    void window.__TAURI__?.event?.emit?.("question-requested", payload);
  };

  // New-chat modal e2e seam (ai_todo 241): open the model/effort/account modal
  // directly so the view-harness can assert the account picker + "Start session"
  // gating WITHOUT driving the full pickProject flow. The account list comes from
  // the mocked list_accounts command, exactly as it would from the daemon on the
  // phone - so this exercises the frontend half of the mobile account-sharing fix.
  (window as unknown as Record<string, unknown>).__openNewChatModal = (
    projectPath?: string,
    projectName?: string,
  ): Promise<unknown> => openModelEffortModal(projectPath ?? "C:/test/proj", projectName ?? "Test Project");
}

registerView("dashboard", renderDashboard);
registerView("sessions", renderSessionsView);
registerView("history", renderHistoryView);
registerView("schedule", renderScheduleView);
registerView("projects", renderProjectsView);
registerView("characters", renderCharactersView);
registerView("character-detail", renderCharacterDetailView);
registerView("news", renderNewsView);
registerView("project-detail", renderProjectDetailView);
registerView("project-character-pick", renderCharacterPickView);
registerView("project-automation", renderAutomationView);
registerView("project-folder-mapping", renderFolderMappingView);
registerView("project-sessions", renderSessionsListView);
registerView("session-detail", renderSessionDetailView);
registerView("settings", renderSettingsView);
registerView("skill-detail", renderSkillDetailView);
registerView("skills", renderSkillsView);
registerView("settings-appearance", renderAppearanceView);
registerView("settings-notifications", renderNotificationsView);
registerView("settings-chat-defaults", renderChatDefaultsView);
registerView("settings-characters", renderCharactersSettingsView);
registerView("settings-system", renderSystemView);
registerView("settings-permissions", renderPermissionsView);
registerView("settings-statusline", renderStatuslineView);
registerView("settings-about", renderAboutView);
registerView("settings-remote-access", renderRemoteAccessView);
registerView("settings-accounts", renderAccountsSettingsView);

const app = document.getElementById("app");
if (!app) {
  throw new Error("Root element #app not found in index.html");
}

// Detached-window mode: backend opens a new Tauri window pointed at
// `index.html#detached?session=<id>`. Detect that URL shape BEFORE
// mounting the normal router (the router would treat "detached?..." as
// an unknown view name) and render the solo session pane instead.
function detachedSessionFromHash(): string | null {
  const hash = window.location.hash || "";
  if (!hash.startsWith("#detached")) return null;
  const qIdx = hash.indexOf("?");
  if (qIdx < 0) return null;
  const params = new URLSearchParams(hash.slice(qIdx + 1));
  return params.get("session");
}

// Install the permission/question relay listener once per window, regardless
// of whether this is the main window or a detached single-session window. The
// listener is a no-op until either a permission-requested or question-requested
// Tauri event fires from the hooks server.
// Signal to the Rust boot watchdog that the webview loaded successfully.
// If this never fires within ~6s, the watchdog reloads the window. Recovers
// from WebView2 "can't reach this page" caused by an unreachable start URL
// at boot (autostart racing the network / vite dev server).
void invoke("frontend_ready").catch(() => {});

installPermissionModalListener();
// Let the permission relay re-render the sidebar when it parks/clears a
// backgrounded chat's prompt (injected to avoid a static import cycle).
setSidebarRerenderHook(() => {
  const listEl = document
    .querySelector<HTMLElement>(".view-sessions")
    ?.querySelector<HTMLElement>("#sessions-list");
  if (listEl) renderSidebar(listEl);
});
installExternalLinkInterceptor();

if (new URLSearchParams(window.location.search).get("chatswindow") === "1") {
  document.body.classList.add("chats-window-mode");
  // The sidemenu has no purpose in the chats window. Drop the DOM entirely
  // so the initial CSS transition can't briefly animate it in during paint.
  document.getElementById("sidemenu")?.remove();
  document.getElementById("sidemenuBackdrop")?.remove();
}

// Standalone Schedule window: backend opens a new window at
// `index.html?schedulewindow=1#schedule`. Render the calendar solo (no router,
// no sidemenu, no boot) - it's single-purpose, like the detached-session window.
const isScheduleWindow = new URLSearchParams(window.location.search).get("schedulewindow") === "1";
if (isScheduleWindow) {
  document.body.classList.add("schedule-window-mode");
  document.getElementById("sidemenu")?.remove();
  document.getElementById("sidemenuBackdrop")?.remove();
}

// Browser-only token gate: shows a full-screen form when no bearer token is
// stored. Complete NO-OP inside the Tauri webview (window.__TAURI__ present).
// Halt boot when the gate rendered its form so no commands are sent without auth.
const detachedSessionId = detachedSessionFromHash();
void (async () => {
if (!await ensureRemoteToken()) {
  // Gate rendered - boot stops here. The form's submit handler reloads the page.
} else if (detachedSessionId) {
  document.body.classList.add("detached-mode");
  // Hide all static legacy views from index.html so only #app renders.
  document.querySelectorAll<HTMLElement>("body > .view").forEach((el) => el.classList.add("hidden"));
  void renderDetachedSession(app, detachedSessionId);
  // Skip mountRouter + sidemenu wiring; this window is single-purpose.
} else if (isScheduleWindow) {
  // Solo calendar render. Hide the static legacy views and mount the schedule
  // view straight into #app; no router, no boot (this window only shows the
  // calendar and cross-navigates to the Chats window on item click).
  document.querySelectorAll<HTMLElement>("body > .view").forEach((el) => el.classList.add("hidden"));
  void renderScheduleView(app);
} else {
  mountRouter(app);
  initBoot();

  // Phone PWA: trap the hardware back button so it navigates within the app
  // instead of closing it. The mobile chat pane is a non-view overlay (a CSS
  // attribute, not a route), so register its back affordance here: back from an
  // open chat returns to the session list before back starts stepping views.
  if (isRemote()) {
    initBackButton();
    registerOverlayBack(() => {
      const el = document.querySelector(".view-sessions");
      if (el?.getAttribute("data-mobile-pane") === "chat") {
        el.setAttribute("data-mobile-pane", "list");
        return true;
      }
      return false;
    });
  }

  if (!document.body.classList.contains("chats-window-mode")) {
    void window.__TAURI__?.event?.listen?.("navigate-to-dashboard", () => {
      void (window as unknown as { navigateTo: (n: string) => Promise<void> }).navigateTo("dashboard");
    });

    // Cross-window jump from the chats window's "Add account" link: navigate
    // to the accounts settings page in the dashboard window instead of the
    // chats window's own router (see navigate-to-project comment below).
    void window.__TAURI__?.event?.listen?.("navigate-to-settings-accounts", () => {
      void (window as unknown as { navigateTo: (n: string) => Promise<void> }).navigateTo("settings-accounts");
    });

    // Cross-window jump from the chats window's per-chat menu: navigate to
    // a specific project's detail page in the main dashboard.
    void window.__TAURI__?.event?.listen?.("navigate-to-project", async (e: { payload: string }) => {
      const cwd = e.payload;
      if (!cwd) return;
      const { openProjectDetail } = await import("./shared/navigation");
      openProjectDetail(cwd);
    });

    // Cross-window jump from a floating-overlay card click: show the dashboard
    // focused on that account.
    void window.__TAURI__?.event?.listen?.("navigate-to-account", async (e: { payload: string }) => {
      const accountId = e.payload;
      if (!accountId) return;
      const { focusDashboardAccount } = await import("./views/dashboard/dashboard");
      focusDashboardAccount(accountId);
      await (window as unknown as { navigateTo: (n: string) => Promise<void> }).navigateTo("dashboard");
    });
  } else {
    // Chats window: honour "Open in chats" and "new chat" requests from the
    // main window. Fresh-created window drains the stashed request on boot;
    // an already-open window catches the live event.
    void invoke<[string, string] | null>("take_pending_chat_open").then((p) => {
      if (p) applyChatOpenRequest(p[0], p[1]);
    }).catch(() => {});
    void invoke<[string, string, string, string] | null>("take_pending_new_chat").then((p) => {
      if (p) applyChatNewRequest(p[0], p[1], p[2], p[3]);
    }).catch(() => {});
    const ev = window.__TAURI__?.event;
    if (ev?.listen) {
      void ev.listen<{ sessionId: string; mode: string }>(
        "chats-open-session",
        (e) => applyChatOpenRequest(e.payload?.sessionId, e.payload?.mode),
      );
      void ev.listen<{ projectPath: string; projectName: string; model: string; effort: string }>(
        "chats-new-chat",
        (e) => applyChatNewRequest(e.payload?.projectPath, e.payload?.projectName, e.payload?.model, e.payload?.effort),
      );
    }
  }

  // Sidemenu wiring (ported from legacy dashboard.js). Burger buttons inside
  // migrated views wire openSidemenu on render; these bindings cover the
  // backdrop + nav-item clicks which live in the static index.html.
  const backdrop = document.getElementById("sidemenuBackdrop");
  if (backdrop) backdrop.onclick = closeSidemenu;

  document.querySelectorAll<HTMLElement>(".sidemenu-nav-item").forEach((item) => {
    item.onclick = () => {
      const view = item.dataset.view;
      // Schedule now lives in its own window (the calendar). Open that instead
      // of routing in-place; fall back to the in-app route in the browser/remote
      // build where there's no separate-window concept.
      if (view === "schedule" && window.__TAURI__) {
        void invoke("open_schedule_window").catch((err) =>
          console.error("[nav] open_schedule_window failed", err),
        );
        closeSidemenu();
        return;
      }
      if (view) showView(view);
      closeSidemenu();
    };
  });

  if (!isRemote()) {
    const chatsNavItem = document.getElementById("sm-chats");
    if (chatsNavItem) chatsNavItem.style.display = "none";
  }

  // Static legacy back buttons still present in index.html.
  const graphBackBtn = document.getElementById("graphDetailBackBtn");
  if (graphBackBtn) graphBackBtn.onclick = () => showView("dashboard");

  document.querySelectorAll<HTMLElement>("#view-settings-sync .back-to-settings").forEach((btn) => {
    btn.onclick = () => showView("settings");
  });

  setupNewsBadgeAndNotifications();
  setupScheduleMissedPopup();
  setupScheduledFireToast();
}
})();

/**
 * Surface a session in the chats window. "live" selects the running session in
 * the Sessions view; "history" opens it read-only in the History view. Both
 * route through the same select-on-mount queues the in-window flows use.
 */
function applyChatOpenRequest(sessionId: string | undefined, mode: string | undefined): void {
  if (!sessionId) return;
  if (mode === "history") {
    queueHistorySelect(sessionId);
    showView("history");
  } else {
    queueSessionSelect(sessionId);
    showView("sessions");
  }
}

function applyChatNewRequest(
  projectPath: string | undefined,
  projectName: string | undefined,
  model: string | undefined,
  effort: string | undefined,
): void {
  if (!projectPath) return;
  queueNewChat(
    { path: projectPath, name: projectName ?? projectPath },
    { model: model ?? "", effort: effort ?? "" },
  );
  showView("sessions");
}

function setupNewsBadgeAndNotifications(): void {
  const navItem = document.getElementById("sm-news");
  if (!navItem) return;

  const setBadge = (unread: number): void => {
    navItem.classList.toggle("has-unread", unread > 0);
  };

  // Initial unread snapshot. The 6h backend poll updates from there.
  void (async () => {
    try {
      const posts = await invoke<NewsPost[]>("list_news");
      setBadge((posts || []).filter((p) => p.unread).length);
    } catch (err) {
      console.warn("[news] initial list_news failed", err);
    }
  })();

  const ev = window.__TAURI__?.event;
  if (!ev?.listen) return;

  void ev.listen<{ unreadCount?: number }>("news-updated", (e) => {
    setBadge(e.payload?.unreadCount ?? 0);
  });

  void ev.listen<{ title?: string; body?: string }>("news-notification", async (e) => {
    const title = e.payload?.title || "Anthropic news";
    const body = e.payload?.body || "";
    try {
      if (typeof Notification !== "undefined") {
        if (Notification.permission === "default") {
          await Notification.requestPermission();
        }
        if (Notification.permission === "granted") {
          const n = new Notification(title, { body });
          n.onclick = () => { void showView("news"); window.focus(); };
          return;
        }
      }
    } catch (err) {
      console.warn("[news] OS notification failed", err);
    }
    // Fallback: lightweight in-app toast.
    const stack = document.getElementById("toastStack");
    if (!stack) return;
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.innerHTML = `<span class="toast-msg"></span>`;
    const msg = toast.querySelector(".toast-msg");
    if (msg) msg.textContent = `${title}: ${body}`.trim();
    toast.onclick = () => { void showView("news"); };
    stack.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("show"));
    setTimeout(() => toast.classList.add("leaving"), 5000);
    setTimeout(() => toast.remove(), 5300);
  });
}

// Scheduled items (messages / new chats) that missed their fire time (past the
// grace window - see `daemon::schedule::compute_missed`). Global, not gated on
// the schedule view being open: fires a dialog (never auto-dismissed, per the
// app's askConfirm convention) plus an OS notification when the window is
// hidden (reusing the same raw `Notification` API as the news-notification
// path above - no new plugin). `seenMissedIds` is in-memory only, cleared on
// relaunch by design: this is "don't let a fresh Missed slip by unnoticed
// this session", not a durable read-receipt.
const seenMissedIds = new Set<string>();

function setupScheduleMissedPopup(): void {
  const ev = window.__TAURI__?.event;
  if (!ev?.listen) return;

  void ev.listen("scheduled-items-changed", async () => {
    let items: ScheduledItem[];
    try {
      items = (await invoke<ScheduledItem[]>("schedule_list")) || [];
    } catch (err) {
      console.warn("[schedule] schedule_list failed", err);
      return;
    }
    const missed = items.filter((i) => i.status.type === "missed" && !seenMissedIds.has(i.id));
    if (missed.length === 0) return;
    for (const m of missed) seenMissedIds.add(m.id);

    const text = `${missed.length} scheduled item${missed.length === 1 ? "" : "s"} missed their fire time.`;

    if (document.hidden) {
      try {
        if (typeof Notification !== "undefined") {
          if (Notification.permission === "default") {
            await Notification.requestPermission();
          }
          if (Notification.permission === "granted") {
            const n = new Notification("Claude Conductor", { body: text });
            n.onclick = () => { window.focus(); void showView("schedule"); };
          }
        }
      } catch (err) {
        console.warn("[schedule] OS notification failed", err);
      }
    }

    const ok = await askConfirm(text, { confirmLabel: "Open schedule", cancelLabel: "Dismiss", danger: false });
    if (ok) showView("schedule");
  });
}

// A scheduled item just fired (daemon -> `scheduled-item-fired`). Pop a
// clickable toast so a scheduled chat/message doesn't spring to life silently
// (Joe's report: a scheduled new-chat "suddenly appeared" mid-response with no
// heads-up). Registered globally in both the main and Chats windows; clicking
// opens the chat via `open_chats_for_session` (which builds/focuses the Chats
// window and resumes a closed session). One event per fire, so no de-dup set.
interface ScheduledFirePayload { id: string; kind: string; session_id: string; prompt: string }

function setupScheduledFireToast(): void {
  const ev = window.__TAURI__?.event;
  if (!ev?.listen) return;

  void ev.listen<ScheduledFirePayload>("scheduled-item-fired", (e) => {
    const p = e.payload;
    if (!p?.session_id) return;
    const isNewChat = p.kind === "new_chat";
    const title = isNewChat ? "Scheduled chat started" : "Scheduled message sent";
    const detail = (p.prompt || "").trim().replace(/\s+/g, " ").slice(0, 60);

    const stack = document.getElementById("toastStack");
    if (!stack) return;
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.innerHTML = `<span class="toast-msg"></span>`;
    const msg = toast.querySelector(".toast-msg");
    if (msg) msg.textContent = detail ? `${title}: ${detail}` : title;
    toast.onclick = () => {
      void invoke("open_chats_for_session", { sessionId: p.session_id, mode: "live" })
        .catch((err) => console.error("[schedule] open_chats_for_session failed", err));
    };
    stack.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("show"));
    setTimeout(() => toast.classList.add("leaving"), 6000);
    setTimeout(() => toast.remove(), 6300);
  });
}

// Register the PWA service worker in browser-only mode (phone/remote client).
// Complete no-op in the Tauri webview: __TAURI__ is present there and SW
// registration would be irrelevant anyway (webview doesn't install PWAs).
if (typeof window !== "undefined" && !window.__TAURI__ && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js");
}
