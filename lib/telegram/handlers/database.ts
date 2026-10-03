/* ============================================================
   Aomi — lib/telegram/handlers/database.ts
   Menu Database: status, info Redis, cleanup (konfirmasi),
   export (owner), statistik. Tanpa tombol FLUSHALL.
   ============================================================ */

import { can } from "../admin";
import { confirmKeyboard, databaseMenu, BACK_MAIN } from "../keyboards";
import type { TgInlineKeyboard } from "../types";
import {
  dbStatus,
  redisInfo,
  cleanupBotState,
  buildExport,
  userStats,
} from "@/lib/server/adminsvc";
import { auditLog } from "@/lib/server/audit";
import { sendMessage } from "../api";
import { fmtMs } from "../format";
import type { Ctx, MenuHandler, View } from "./types";

const kb = (rows: [string, string][][]): TgInlineKeyboard => ({
  inline_keyboard: rows.map((r) => r.map(([text, data]) => ({ text, callback_data: data }))),
});

export async function renderDatabase(): Promise<View> {
  const db = await dbStatus();
  return {
    text: [
      "🗄 Database",
      "",
      `Storage: ${db.ok ? "🟢" : "🔴"} ${db.provider}`,
      `Latency: ${db.ok ? fmtMs(db.latencyMs) : "—"}`,
      "",
      "Pilih aksi di bawah.",
    ].join("\n"),
    kb: databaseMenu(),
  };
}

export const databaseHandler: MenuHandler = {
  node: "DB",

  async render(): Promise<View> {
    return renderDatabase();
  },

  async onAction(action, ctx, confirmed): Promise<View | null> {
    if (!action.startsWith("db:")) return null;
    const menu = (await renderDatabase()).kb;

    if (action === "db:status") {
      const db = await dbStatus();
      return {
        text: `🩺 Database\n\nStorage: ${db.ok ? "🟢 Terhubung" : "🔴 Tidak terhubung"}\nProvider: ${db.provider}\nLatency: ${db.ok ? fmtMs(db.latencyMs) : "—"}`,
        kb: menu,
      };
    }

    if (action === "db:redis") {
      const info = await redisInfo();
      if (!info) {
        return {
          text: "ℹ️ Mode fallback GitHub aktif (env Upstash belum diset).\nRedis tidak dipakai saat ini — info Redis tidak tersedia.",
          kb: menu,
        };
      }
      return {
        text: [
          "ℹ️ Redis Info",
          "",
          `Status: ${info.keys === null ? "🔴" : "🟢"} ${info.keys !== null ? "Terhubung" : "Tidak terhubung"}`,
          `Latency: ${fmtMs(info.latencyMs)}`,
          `Total keys: ${info.keys ?? "—"}`,
          `Memory terpakai: ${info.memory ?? "—"}`,
          `Versi Redis: ${info.version ?? "—"}`,
          "",
          "(Tanpa kredensial — rahasia tidak pernah dikirim ke chat.)",
        ].join("\n"),
        kb: menu,
      };
    }

    if (action === "db:cleanup") {
      if (!can(ctx.admin, "operate")) return { text: "⛔ Akses ditolak untuk aksi ini.", kb: menu };
      if (!confirmed) {
        ctx.session.pending = { menu: "DB", action };
        return {
          text: "🧹 Cleanup state bot Telegram?\n\nDihapus: sesi bot & penanda update Telegram (aman — otomatis dibuat ulang).\nData user, chat, dan file gambar TIDAK disentuh.",
          kb: confirmKeyboard("🧹 Ya, bersihkan"),
        };
      }
      try {
        const n = await cleanupBotState();
        await auditLog({
          admin_id: ctx.admin.id,
          role: ctx.admin.role,
          action: "database.cleanup",
          target: "telegram/state",
          result: "ok",
          detail: `deleted=${n}`,
        });
        return { text: `✅ Cleanup selesai — ${n} key state bot dihapus.`, kb: menu };
      } catch {
        return { text: "❌ Operasi gagal — storage tidak bisa dihubungi.", kb: menu };
      }
    }

    if (action === "db:export") {
      if (!can(ctx.admin, "owner")) return { text: "⛔ Akses ditolak untuk aksi ini.", kb: menu };
      try {
        const { json, usersIncluded } = await buildExport();
        await auditLog({
          admin_id: ctx.admin.id,
          role: ctx.admin.role,
          action: "database.export",
          target: "site",
          result: "ok",
          detail: `users=${usersIncluded}`,
        });
        await sendMessage(ctx.admin.id, "📦 Menyiapkan export...");
        await sendMessage(
          ctx.admin.id,
          "📦 Export dikirim sebagai dokumen. Isi: konfigurasi maintenance, pengumuman, feature flags, statistik, dan daftar user (email disamarkan). Tanpa password/token."
        );
        const { sendDocument } = await import("../api");
        await sendDocument(
          ctx.admin.id,
          `aomi-export-${new Date().toISOString().slice(0, 10)}.json`,
          "application/json",
          new TextEncoder().encode(json),
          "Aomi export konfigurasi"
        );
        return { text: "✅ Export dikirim sebagai dokumen di atas.", kb: menu };
      } catch {
        return { text: "❌ Export gagal — coba lagi nanti.", kb: menu };
      }
    }

    if (action === "db:stats") {
      const s = await userStats();
      return {
        text: [
          "📈 Statistik",
          "",
          `Total user: ${s.total}`,
          `User dibekukan: ${s.suspended}`,
          `Sesi aktif: ${s.sessions}`,
          `File gambar sementara: ${s.tempimg}`,
          `Lock login (brute force): ${s.activeLocks}`,
        ].join("\n"),
        kb: menu,
      };
    }

    return null;
  },

  async onInput(): Promise<View | null> {
    return null;
  },
};

export { kb as mkKb };
