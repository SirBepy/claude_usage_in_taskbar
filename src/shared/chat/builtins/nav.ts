import { showView } from "../../navigation";
import type { BuiltinHandler } from "./index";

export const showConfig: BuiltinHandler = () => {
  showView("settings");
};

export const showPermissions: BuiltinHandler = () => {
  showView("settings");
};
