/* ============================================================
   Aomi — lib/telegram/handlers/users.ts
   Menu Users: cari, terbaru, statistik, detail, suspend/unsuspend
   (konfirmasi, permission "manage"). Tanpa data sensitif berlebihan.
   ============================================================ */

import { can } from "../admin";
import { confirmKeyboard, usersMenu, usersListKeyboard, userDetailKeyboard, BACK_MAIN } from "../keyboards";
import type { TgInlineKeyboard } from "../types";
import {
  searchUsers,
  recentUsers,
  userStats,
  userDetail,
  suspendUser,
  unsuspendUser,
} from "@/lib/server/adminsvc";
import { auditLog } from "@/lib/server/audit";
import { fmtWIB } from "../format";
import type { Ctx, MenuHandler, View } from "./types";

const kb = (rows: [string, string][][]): TgInlineKeyboard => ({
  inline_keyboard: rows.map((r) => r.map(([text, data]) => ({ text, callback_data: data }))),
});

export async function renderUsers(): Promise<View> {
  const s = await userStats();
  return {
    text: [
      "👥 Users",
      "",
      `Total user: ${s.total}`,
      `Dibekukan: ${s.suspended}`,
      "",
      "Pilih aksi di bawah.",
    ].join("\n"),
    kb: usersMenu(),
  };
}

export const usersHandler: MenuHandler = {
  node: "USERS",

  async render(): Promise<View> {
    return renderUsers();
  },

  async onAction(action, ctx, confirmed): Promise<View | null> {
    const menu = (await renderUsers()).kb;

    if (action === "users:search") {
      ctx.session.input = "user_search";
      return {
        text: "🔎 Kirim email, username, atau user ID yang dicari.\n\nKirim /menu untuk membatalkan.",
        kb: kb(BACK_MAIN),
      };
    }

    if (action === "users:recent") {
      const users = await recentUsers(5);
      if (!users.length) return { text: "Belum ada user terdaftar.", kb: menu };
      return {
        text: "🕒 User terbaru:\n\n" + users.map((u) => `• ${u.username} — ${u.suspended ? "⛔ suspended" : "🟢 aktif"} (${u.id.slice(0, 8)}…)`).join("\n"),
        kb: usersListKeyboard(users.map((u) => ({ id: u.id, label: `👤 ${u.username}` }))),
      };
    }

    if (action === "users:stats") {
      const s = await userStats();
      return {
        text: [
          "📈 Statistik Users",
          "",
          `Total: ${s.total}`,
          `Dibekukan: ${s.suspended}`,
          `Sesi aktif: ${s.sessions}`,
        ].join("\n"),
        kb: menu,
      };
    }

    if (action.startsWith("user:")) {
      const id = action.slice(5);
      const u = await userDetail(id);
      if (!u) return { text: "User tidak ditemukan.", kb: menu };
      return {
        text: [
          "👤 Detail User",
          "",
          `Username: ${u.username}`,
          `ID: ${u.id}`,
          `Status: ${u.suspended ? "⛔ Dibekukan" : "🟢 Aktif"}`,
          `Terdaftar: ${fmtWIB(u.created_at)}`,
        ].join("\n"),
        kb: userDetailKeyboard(u.id, u.suspended),
      };
    }

    const suspMatch = action.match(/^usersuspend:(.+)$/);
    const unsuspMatch = action.match(/^userunsuspend:(.+)$/);
    if (suspMatch || unsuspMatch) {
      if (!can(ctx.admin, "manage")) return { text: "⛔ Akses ditolak untuk aksi ini.", kb: menu };
      const id = String((suspMatch || unsuspMatch)![1]);
      const u = await userDetail(id);
      if (!u) return { text: "User tidak ditemukan.", kb: menu };
      const suspending = Boolean(suspMatch);
      if (!confirmed) {
        ctx.session.pending = { menu: "USERS", action };
        return {
          text: suspending
            ? `Bekukan user "${u.username}"?\n\nUser tidak bisa login & chat sampai di-unfreeze. Percakapan tetap tersimpan.`
            : `Buka pembekuan user "${u.username}"?\n\nUser bisa login & chat kembali.`,
          kb: confirmKeyboard(suspending ? "⛔ Ya, bekukan" : "✅ Ya, buka"),
        };
      }
      try {
        const ok = suspending ? await suspendUser(id) : await unsuspendUser(id);
        if (!ok) return { text: "User tidak ditemukan.", kb: menu };
        await auditLog({
          admin_id: ctx.admin.id,
          role: ctx.admin.role,
          action: suspending ? "user.suspended" : "user.unsuspended",
          target: `user:${id.slice(0, 8)}…`,
          result: "ok",
          detail: "",
        });
        return {
          text: suspending ? `✅ User "${u.username}" dibekukan.` : `✅ User "${u.username}" dibuka kembali.`,
          kb: menu,
        };
      } catch {
        return { text: "❌ Operasi gagal — storage tidak bisa dihubungi.", kb: menu };
      }
    }

    return null;
  },

  async onInput(text, ctx): Promise<View | null> {
    if (ctx.session.input !== "user_search") return null;
    ctx.session.input = null;
    try {
      const users = await searchUsers(text);
      if (!users.length) {
        return { text: "🔎 Tidak ada user yang cocok. Coba email/username/ID lain.", kb: (await renderUsers()).kb };
      }
      return {
        text:
          "🔎 Hasil pencarian:\n\n" +
          users.map((u) => `• ${u.username} — ${u.suspended ? "⛔ suspended" : "🟢 aktif"}`).join("\n"),
        kb: usersListKeyboard(users.map((u) => ({ id: u.id, label: `👤 ${u.username}` }))),
      };
    } catch {
      return { text: "❌ Pencarian gagal — storage tidak bisa dihubungi.", kb: (await renderUsers()).kb };
    }
  },
};
