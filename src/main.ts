import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/themes.css";

import { mountRouter } from "./router";

const app = document.getElementById("app");
if (!app) {
  throw new Error("Root element #app not found in index.html");
}

mountRouter(app);
