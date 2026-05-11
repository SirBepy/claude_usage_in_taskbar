// Central handler registration. Imported by composer.ts for side-effects.
// Each handler module's import here triggers assignment to HANDLERS.

import { HANDLERS } from "./index";
import { clearSession } from "./clear";
import { showHelp } from "./help";
import { showCost } from "./cost";
import { exitSession } from "./exit";
import { showConfig, showPermissions } from "./nav";

HANDLERS.clear = clearSession;
HANDLERS.help = showHelp;
HANDLERS.cost = showCost;
HANDLERS.exit = exitSession;
HANDLERS.config = showConfig;
HANDLERS.permissions = showPermissions;
