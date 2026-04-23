import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/themes.css";

import { mountRouter, registerView } from "./router";
import { renderDashboard } from "./views/dashboard/dashboard";
import { renderStatisticsView } from "./views/statistics/statistics";

registerView("dashboard", renderDashboard);
registerView("statistics", renderStatisticsView);

const app = document.getElementById("app");
if (!app) {
  throw new Error("Root element #app not found in index.html");
}

mountRouter(app);
