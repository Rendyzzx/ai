/* ============================================================
   Aomi — lib/telegram/handlers/database.ts
   Menu Database: status, info Redis, cleanup (konfirmasi),
   export (owner), statistik, reset user+chat (persetujuan owner).
   Tanpa tombol FLUSHALL.
   ============================================================ */

import { can, parseAdmins } from "../admin";
import { confirmKeyboard, databaseMenu, BACK_MAIN, wipeRequestKeyboard } from "../keyboards";
import type { TgInlineKeyboard } from "../types";
import {
  dbStatus,
  redisInfo,
  cleanupBotState,
  buildExport,
  userStats,
  wipePreview,
  wipeUserData,
  createWipeRequest,
  takeWipeRequest,
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

/** Jalankan wipe + audit. Dipakai jalur owner-langsung maupun persetujuan. */
async function runWipe(admin: { id: number; role: string }): Promise<View> {
  const menu = (await renderDatabase()).kb;
  try {
    const r = await wipeUserData();
    await auditLog({
      admin_id: admin.id,
      role: admin.role,
      action: "database.wipe",
      target: "users+chats",
      result: "ok",
      detail: `users=${r.users} chats=${r.chats} bots=${r.bots} sessions=${r.sessions} locks=${r.locks} tempimg=${r.tempimg}`,
    });
    return {
      text: [
        "✅ Reset User & Chat selesai.",
        "",
        `• Akun & profil user: ${r.users}`,
        `• File percakapan: ${r.chats}`,
        `• Konfigurasi karakter: ${r.bots}`,
        `• Sesi login: ${r.sessions}`,
        `• Lock login: ${r.locks}`,
        `• Gambar sementara: ${r.tempimg}`,
        "",
        "Semua user harus mendaftar ulang. Config situs, asset, dan audit log tidak tersentuh.",
      ].join("\n"),
      kb: menu,
    };
  } catch {
    await auditLog({
      admin_id: admin.id,
      role: admin.role,
      action: "database.wipe",
      target: "users+chats",
      result: "fail",
      detail: "storage error",
    }).catch(() => {});
    return { text: "❌ Reset gagal — storage tidak bisa dihubungi. Sebagian data mungkin sudah terhapus.", kb: menu };
  }
}

export const databaseHandler: MenuHandler = {
  node: "DB",

  async render(): Promise<View> {
    return renderDatabase();
  },

  async onAction(action, ctx, confirmed): Promise<View | null> {
    if (!action.startsWith("db:") && !action.startsWith("dbwipe:")) return null;
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

    // ---- 💥 Reset User & Chat (butuh persetujuan OWNER) ----
    if (action === "db:wipe") {
      if (!can(ctx.admin, "manage")) {
        return { text: "⛔ Akses ditolak untuk aksi ini (minimal ADMIN untuk mengusulkan).", kb: menu };
      }
      if (!confirmed) {
        const p = await wipePreview().catch(() => null);
        ctx.session.pending = { menu: "DB", action };
        return {
          text: [
            "💥 RESET USER & CHAT — TINDAKAN BERAT",
            "",
            "Menghapus SEKALIGUS:",
            `• Seluruh akun & profil user${p ? ` (±${p.users} user)` : ""}`,
            "• Seluruh riwayat chat semua user",
            "• Konfigurasi karakter per user",
            `• Semua sesi login${p ? ` (±${p.sessions})` : ""}, lock login, gambar sementara`,
            "",
            "TIDAK tersentuh: config situs, maintenance, asset, audit log, state bot.",
            "TIDAK BISA DIURUNGKAN.",
            "",
            can(ctx.admin, "owner")
              ? "Kamu OWNER — konfirmasi ini adalah persetujuan dan reset langsung dijalankan."
              : "Setelah kamu konfirmasi, OWNER harus menekan Setujui dulu sebelum reset dijalankan.",
          ].join("\n"),
          kb: confirmKeyboard("💥 Ya, lanjutkan"),
        };
      }

      // OWNER yang konfirmasi → persetujuan terpenuhi → jalankan langsung.
      if (can(ctx.admin, "owner")) {
        return await runWipe(ctx.admin);
      }

      // Admin non-owner → kirim permintaan ke semua OWNER untuk disetujui.
      try {
        const req = await createWipeRequest({ id: ctx.admin.id, role: ctx.admin.role });
        const owners = parseAdmins(process.env.TELEGRAM_ADMIN_IDS).filter((a) => a.role === "OWNER");
        const text = [
          "💥 PERMINTAAN RESET USER & CHAT",
          "",
          `Diminta oleh admin ${req.requested_by_id} (${req.requested_by_role})`,
          "",
          "Menunggu persetujuan kamu. Aksi menghapus SEMUA akun user, riwayat chat,",
          "config karakter, sesi login, lock login, dan gambar sementara.",
          "Permintaan kedaluwarsa otomatis dalam 15 menit.",
        ].join("\n");
        for (const o of owners) {
          if (o.id !== ctx.admin.id) {
            await sendMessage(o.id, text, wipeRequestKeyboard(req.id)).catch(() => {});
          }
        }
        await auditLog({
          admin_id: ctx.admin.id,
          role: ctx.admin.role,
          action: "database.wipe_requested",
          target: "users+chats",
          result: "ok",
          detail: `req=${req.id}`,
        });
        return {
          text: "⏳ Permintaan reset dikirim ke owner.\n\nReset hanya dijalankan setelah owner menekan Setujui. Permintaan kedaluwarsa dalam 15 menit.",
          kb: menu,
        };
      } catch {
        return { text: "❌ Gagal membuat permintaan — storage tidak bisa dihubungi.", kb: menu };
      }
    }

    // ---- Persetujuan OWNER (tombol di chat owner) ----
    if (action.startsWith("dbwipe:approve:") || action.startsWith("dbwipe:deny:")) {
      const approve = action.startsWith("dbwipe:approve:");
      const id = action.split(":")[2] || "";
      if (!can(ctx.admin, "owner")) {
        return { text: "⛔ Hanya OWNER yang bisa memproses persetujuan ini.", kb: menu };
      }
      const taken = await takeWipeRequest(id).catch(() => ({ status: "gone" } as const));
      if (taken.status !== "ok") {
        const why = taken.status === "expired" ? "kedaluwarsa" : "sudah diproses atau tidak ditemukan";
        return { text: `Permintaan reset ${why}. Tidak ada yang dijalankan.`, kb: menu };
      }
      const req = taken.req;

      if (!approve) {
        await auditLog({
          admin_id: ctx.admin.id,
          role: ctx.admin.role,
          action: "database.wipe_denied",
          target: "users+chats",
          result: "ok",
          detail: `req=${req.id} by=${req.requested_by_id}`,
        });
        await sendMessage(req.requested_by_id, "❌ Permintaan reset user & chat DITOLAK owner. Tidak ada data yang dihapus.").catch(() => {});
        return { text: "✅ Permintaan reset ditolak. Peminta sudah diberi tahu.", kb: menu };
      }

      const view = await runWipe(ctx.admin);
      await sendMessage(req.requested_by_id, "✅ Permintaan reset user & chat kamu DISETUJUI owner dan sudah dijalankan.").catch(() => {});
      return view;
    }

    return null;
  },

  async onInput(): Promise<View | null> {
    return null;
  },
};

export { kb as mkKb };
