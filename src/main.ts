import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/themes.css";
import "./styles/widgets.css";

import { mountRouter, registerView } from "./router";
import { renderDashboard } from "./views/dashboard/dashboard";
import { renderSessionsView, renderDetachedSession } from "./views/sessions/sessions";
import { renderHistoryView } from "./views/history/history";
import { renderStatisticsView } from "./views/statistics/statistics";
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
import { renderVisualsView } from "./views/settings/subviews/visuals/visuals";
import { renderThemesView } from "./views/settings/subviews/themes/themes";
import { renderNotificationsView } from "./views/settings/subviews/notifications/notifications";
import { renderPresetsView } from "./views/settings/subviews/presets/presets";
import { renderShortcutsView } from "./views/settings/subviews/shortcuts/shortcuts";
import { renderPermissionsView } from "./views/settings/subviews/permissions/permissions";
import { renderStatuslineView } from "./views/settings/subviews/statusline/statusline";
import { initBoot } from "./shared/boot";
import { showView } from "./shared/navigation";
import { closeSidemenu } from "./shared/sidemenu";
import { installPermissionModalListener, setSidebarRerenderHook } from "./views/sessions/permission-modal";
import { renderSidebar } from "./views/sessions/sidebar";
import { installExternalLinkInterceptor } from "./shared/external-links";
import { invoke } from "./shared/ipc";
import { sessionEvents } from "./shared/chat/event-store";
import type { ChatEvent, NewsPost } from "./types/ipc.generated";

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
    };
    sessionEvents.pushSynthetic(sessionId, ev);
  };
}

registerView("dashboard", renderDashboard);
registerView("sessions", renderSessionsView);
registerView("history", renderHistoryView);
registerView("statistics", renderStatisticsView);
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
registerView("settings-visuals", renderVisualsView);
registerView("settings-themes", renderThemesView);
registerView("settings-notifications", renderNotificationsView);
registerView("settings-presets", renderPresetsView);
registerView("settings-shortcuts", renderShortcutsView);
registerView("settings-permissions", renderPermissionsView);
registerView("settings-statusline", renderStatuslineView);

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

const detachedSessionId = detachedSessionFromHash();
if (detachedSessionId) {
  document.body.classList.add("detached-mode");
  // Hide all static legacy views from index.html so only #app renders.
  document.querySelectorAll<HTMLElement>("body > .view").forEach((el) => el.classList.add("hidden"));
  void renderDetachedSession(app, detachedSessionId);
  // Skip mountRouter + sidemenu wiring; this window is single-purpose.
} else {
  mountRouter(app);
  initBoot();

  if (!document.body.classList.contains("chats-window-mode")) {
    void window.__TAURI__?.event?.listen("navigate-to-dashboard", () => {
      void (window as unknown as { navigateTo: (n: string) => Promise<void> }).navigateTo("dashboard");
    });

    // Cross-window jump from the chats window's per-chat menu: navigate to
    // a specific project's detail page in the main dashboard.
    void window.__TAURI__?.event?.listen<string>("navigate-to-project", async (e) => {
      const cwd = e.payload;
      if (!cwd) return;
      const { openProjectDetail } = await import("./shared/navigation");
      openProjectDetail(cwd);
    });
  }

  // Sidemenu wiring (ported from legacy dashboard.js). Burger buttons inside
  // migrated views wire openSidemenu on render; these bindings cover the
  // backdrop + nav-item clicks which live in the static index.html.
  const backdrop = document.getElementById("sidemenuBackdrop");
  if (backdrop) backdrop.onclick = closeSidemenu;

  document.querySelectorAll<HTMLElement>(".sidemenu-nav-item").forEach((item) => {
    item.onclick = () => {
      const view = item.dataset.view;
      if (view) showView(view);
      closeSidemenu();
    };
  });

  // Static legacy back buttons still present in index.html.
  const graphBackBtn = document.getElementById("graphDetailBackBtn");
  if (graphBackBtn) graphBackBtn.onclick = () => showView("dashboard");

  document.querySelectorAll<HTMLElement>("#view-settings-sync .back-to-settings").forEach((btn) => {
    btn.onclick = () => showView("settings");
  });

  setupNewsBadgeAndNotifications();
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
