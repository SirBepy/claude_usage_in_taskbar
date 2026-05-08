import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/themes.css";
import "./styles/widgets.css";

import { mountRouter, registerView } from "./router";
import { renderDashboard } from "./views/dashboard/dashboard";
import { renderSessionsView } from "./views/sessions/sessions";
import { renderHistoryView } from "./views/history/history";
import { renderStatisticsView } from "./views/statistics/statistics";
import { renderProjectsView } from "./views/projects/projects";
import { renderCharactersView } from "./views/characters/characters";
import { renderCharacterDetailView } from "./views/characters/character-detail";
import { renderProjectDetailView } from "./views/project-detail/project-detail";
import { renderCharacterPickView } from "./views/project-detail/subviews/character-pick/character-pick";
import { renderAutomationView } from "./views/project-detail/subviews/automation/automation";
import { renderFolderMappingView } from "./views/project-detail/subviews/folder-mapping/folder-mapping";
import { renderSessionsListView } from "./views/project-detail/subviews/sessions-list/sessions-list";
import { renderSessionDetailView } from "./views/session-detail/session-detail";
import { renderSettingsView } from "./views/settings/settings";
import { renderVisualsView } from "./views/settings/subviews/visuals/visuals";
import { renderThemesView } from "./views/settings/subviews/themes/themes";
import { renderNotificationsView } from "./views/settings/subviews/notifications/notifications";
import { initBoot } from "./shared/boot";
import { showView } from "./shared/navigation";
import { closeSidemenu } from "./shared/sidemenu";

registerView("dashboard", renderDashboard);
registerView("sessions", renderSessionsView);
registerView("history", renderHistoryView);
registerView("statistics", renderStatisticsView);
registerView("projects", renderProjectsView);
registerView("characters", renderCharactersView);
registerView("character-detail", renderCharacterDetailView);
registerView("project-detail", renderProjectDetailView);
registerView("project-character-pick", renderCharacterPickView);
registerView("project-automation", renderAutomationView);
registerView("project-folder-mapping", renderFolderMappingView);
registerView("project-sessions", renderSessionsListView);
registerView("session-detail", renderSessionDetailView);
registerView("settings", renderSettingsView);
registerView("settings-visuals", renderVisualsView);
registerView("settings-themes", renderThemesView);
registerView("settings-notifications", renderNotificationsView);

const app = document.getElementById("app");
if (!app) {
  throw new Error("Root element #app not found in index.html");
}

mountRouter(app);
initBoot();

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
