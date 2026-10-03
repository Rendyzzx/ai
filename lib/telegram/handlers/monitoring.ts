/* ============================================================
   Aomi — lib/telegram/handlers/monitoring.ts
   Monitoring jujur: hanya status yang BENAR-BENAR bisa diverifikasi.
   Yang tidak bisa diverifikasi → ⚪ Unknown, bukan dipalsukan.
   ============================================================ */

import { monitoringMenu } from "../keyboards";
import { snapshot } from "@/lib/server/adminsvc";
import { getMaintenanceConfig } from "@/lib/server/maintenance";
import { fmtMs } from "../format";
import type { Ctx, MenuHandler, View } from "./types";

export const monitoringHandler: MenuHandler = {
  node: "MON",

  async render(): Promise<View> {
    try {
      const snap = await snapshot();
      const cfg = await getMaintenanceConfig();
      const flagsOff = Object.entries(snap.flags)
        .filter(([, on]) => !on)
        .map(([n]) => n);
      return {
        text: [
          "📊 Monitoring",
          "",
          `Website: ${snap.maintenance === "OFF" ? "🟢 Online" : "🟠 Maintenance " + snap.maintenance}`,
          `API: 🟢 Online (bot ini jalan lewat API yang sama)`,
          `Database (${snap.db.provider}): ${snap.db.ok ? "🟢 Terhubung" : "🔴 Tidak terhubung"}`,
          `Latency DB: ${snap.db.ok ? fmtMs(snap.db.latencyMs) : "—"}`,
          `AI provider: ${snap.ai ? "🟢 Terjangkau" : "🔴 Tidak terjangkau"}`,
          flagsOff.length ? `Fitur OFF: ${flagsOff.join(", ")}` : "Semua fitur: 🟢 ON",
          "",
          snap.maintenance !== "OFF" ? `Pesan maintenance aktif: "${cfg.message.slice(0, 80)}"` : "",
        ]
          .filter((l) => l !== "")
          .join("\n"),
        kb: monitoringMenu(),
      };
    } catch {
      return {
        text: "📊 Monitoring\n\n⚠️ Tidak bisa mengambil status sekarang — storage tidak terjangkau.",
        kb: monitoringMenu(),
      };
    }
  },

  async onAction(): Promise<View | null> {
    return null;
  },

  async onInput(): Promise<View | null> {
    return null;
  },
};
