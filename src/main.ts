import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/themes.css";

import { mountRouter, registerView } from "./router";
import { renderDashboard } from "./views/dashboard/dashboard";
import { renderStatisticsView } from "./views/statistics/statistics";
import { renderProjectsView } from "./views/projects/projects";
import { renderProjectDetailView } from "./views/project-detail/project-detail";
import { renderNotifOverridesView } from "./views/project-detail/subviews/notif-overrides/notif-overrides";
import { renderAutomationView } from "./views/project-detail/subviews/automation/automation";
import { renderFolderMappingView } from "./views/project-detail/subviews/folder-mapping/folder-mapping";
import { renderSessionsListView } from "./views/project-detail/subviews/sessions-list/sessions-list";
import { renderSessionDetailView } from "./views/session-detail/session-detail";

registerView("dashboard", renderDashboard);
registerView("statistics", renderStatisticsView);
registerView("projects", renderProjectsView);
registerView("project-detail", renderProjectDetailView);
registerView("project-notif-overrides", renderNotifOverridesView);
registerView("project-automation", renderAutomationView);
registerView("project-folder-mapping", renderFolderMappingView);
registerView("project-sessions", renderSessionsListView);
registerView("session-detail", renderSessionDetailView);

const app = document.getElementById("app");
if (!app) {
  throw new Error("Root element #app not found in index.html");
}

mountRouter(app);
