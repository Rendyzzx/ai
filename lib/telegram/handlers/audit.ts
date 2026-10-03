/* ============================================================
   Aomi — lib/telegram/handlers/audit.ts
   Audit log — entri terakhir, format ringkas. Tanpa secret.
   ============================================================ */

import { auditMenu } from "../keyboards";
import { auditRecent } from "@/lib/server/audit";
import { fmtWIB } from "../format";
import type { Ctx, MenuHandler, View } from "./types";

export const auditHandler: MenuHandler = {
  node: "AUDIT",

  async render(): Promise<View> {
    try {
      const entries = await auditRecent(8);
      if (!entries.length) {
        return {
          text: "🧾 Audit Log\n\nBelum ada aksi admin yang tercatat. Setiap aksi penting (maintenance, fitur, user, sesi) otomatis tercatat di sini.",
          kb: auditMenu(),
        };
      }
      const lines = entries.map(
        (e) => `${fmtWIB(e.at).slice(0, 17)} • ${e.role}\n  ${e.action} → ${e.target} (${e.result})`
      );
      return {
        text: ["🧾 Audit Log (8 terakhir)", "", ...lines].join("\n"),
        kb: auditMenu(),
      };
    } catch {
      return { text: "🧾 Audit Log\n\n⚠️ Tidak bisa membaca log sekarang.", kb: auditMenu() };
    }
  },

  async onAction(): Promise<View | null> {
    return null;
  },

  async onInput(): Promise<View | null> {
    return null;
  },
};
