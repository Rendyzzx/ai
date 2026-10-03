/* ============================================================
   Aomi — lib/telegram/handlers/index.ts
   Registry handler per node sesi.
   ============================================================ */

import type { MenuHandler } from "./types";
import { mainHandler } from "./main";
import { maintenanceHandler } from "./maintenance";
import { databaseHandler } from "./database";
import { usersHandler } from "./users";
import { featuresHandler } from "./features";
import { monitoringHandler } from "./monitoring";
import { securityHandler } from "./security";
import { settingsHandler } from "./settings";
import { announcementHandler } from "./announcement";
import { auditHandler } from "./audit";

export const MENU_HANDLERS: Record<string, MenuHandler> = {
  MAIN: mainHandler,
  MAINT: maintenanceHandler,
  DB: databaseHandler,
  USERS: usersHandler,
  FEAT: featuresHandler,
  MON: monitoringHandler,
  SEC: securityHandler,
  CFG: settingsHandler,
  ANN: announcementHandler,
  AUDIT: auditHandler,
};

export { renderMain } from "./main";
export { renderMaintenance } from "./maintenance";
export { renderDatabase } from "./database";
export { renderUsers } from "./users";
export { renderFeatures } from "./features";
export { renderSecurity } from "./security";
export { renderConfig } from "./settings";
export { renderAnnouncement } from "./announcement";
