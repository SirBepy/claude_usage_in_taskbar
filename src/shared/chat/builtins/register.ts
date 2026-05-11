// Central handler registration. Imported by composer.ts for side-effects.
// Each handler module's import here triggers assignment to HANDLERS.

import { HANDLERS } from "./index";
import { clearSession } from "./clear";
import { showHelp } from "./help";
import { showCost } from "./cost";

HANDLERS.clear = clearSession;
HANDLERS.help = showHelp;
HANDLERS.cost = showCost;
