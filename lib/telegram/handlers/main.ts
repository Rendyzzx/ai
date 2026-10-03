/* ============================================================
   Aomi — lib/telegram/handlers/main.ts
   Menu utama + tampilan Website (status ringkas, tanpa secret).
   ============================================================ */

import { can } from "../admin";
import { mainMenu } from "../keyboards";
import { dbStatus } from "@/lib/server/adminsvc";
import { isMaintenanceActive, getMaintenanceConfig } from "@/lib/server/maintenance";
import { APP_VERSION } from "@/lib/server/version";
import type { Ctx, MenuHandler, View } from "./types";
import { fmtWIB } from "../format";

async function statusLine(): Promise<string> {
  const active = await isMaintenanceActive().catch(() => false);
  return active ? "🟠 Maintenance ON" : "🟢 Website Online";
}

export async function renderMain(): Promise<View> {
  const active = await isMaintenanceActive().catch(() => false);
  return {
    text: `Aomi Admin\n\nStatus: ${active ? "🟠 Maintenance ON" : "🟢 Website Online"}\n\nPilih menu di bawah 👇`,
    kb: mainMenu(await statusLine()),
  };
}

export const mainHandler: MenuHandler = {
  node: "MAIN",

  async render(): Promise<View> {
    return renderMain();
  },

  async onAction(action, ctx: Ctx): Promise<View | null> {
    if (action !== "web") return null;
    if (!can(ctx.admin, "read")) return { text: "⛔ Akses ditolak.", kb: mainMenu(await statusLine()) };
    const [db, active, cfg] = await Promise.all([
      dbStatus(),
      isMaintenanceActive().catch(() => false),
      getMaintenanceConfig(),
    ]);
    const env =
      process.env.VERCEL_ENV || process.env.NODE_ENV || "unknown";
    const text = [
      "🖥 Website",
      "",
      `Status: ${active ? "🟠 Maintenance" : "🟢 Online"}`,
      `Domain: cyronime.web.id`,
      `Environment: ${env}`,
      `Version: ${APP_VERSION}`,
      `Database: ${db.ok ? "🟢" : "🔴"} ${db.provider}`,
      `Build: ${APP_VERSION}`,
      "",
      active ? `Pesan maintenance saat ini:\n"${cfg.message}"` : "",
    ]
      .filter((l) => l !== "")
      .join("\n");
    return { text, kb: mainMenu(await statusLine()) };
  },

  async onInput(): Promise<View | null> {
    return null;
  },
};

export async function lastUpdatedNote(): Promise<string> {
  return `Diperbarui ${fmtWIB(new Date().toISOString())}`;
}
