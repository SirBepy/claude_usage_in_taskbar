import { dismountActivePane } from "../../../views/sessions/active-session";
import type { BuiltinHandler } from "./index";

export const exitSession: BuiltinHandler = () => {
  dismountActivePane({ rerenderSidebar: false });
};
