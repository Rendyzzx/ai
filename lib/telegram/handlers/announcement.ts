/* ============================================================
   Aomi — lib/telegram/handlers/announcement.ts
   Pengumuman website (banner di halaman chat). Set teks (input),
   on/off (konfirmasi), preview. Bukan broadcast Telegram.
   ============================================================ */

import { can } from "../admin";
import { announcementMenu, confirmKeyboard, BACK_MAIN } from "../keyboards";
import type { TgInlineKeyboard } from "../types";
import { getAnnouncement, setAnnouncement } from "@/lib/server/announce";
import { auditLog } from "@/lib/server/audit";
import { fmtWIB } from "../format";
import type { Ctx, MenuHandler, View } from "./types";

const kb = (rows: [string, string][][]): TgInlineKeyboard => ({
  inline_keyboard: rows.map((r) => r.map(([text, data]) => ({ text, callback_data: data }))),
});

export async function renderAnnouncement(): Promise<View> {
  const ann = await getAnnouncement();
  return {
    text: [
      "📢 Announcement (banner website)",
      "",
      `Status: ${ann.enabled ? "🟢 Aktif" : "⚪ Nonaktif"}`,
      `Judul: ${ann.title}`,
      `Pesan: ${ann.message || "(kosong)"}`,
      ann.updated_at ? `Diubah: ${fmtWIB(ann.updated_at)}` : "",
      "",
      "Banner tampil di atas halaman chat. Bukan broadcast Telegram.",
    ]
      .filter((l) => l !== "")
      .join("\n"),
    kb: announcementMenu(ann.enabled),
  };
}

export const announcementHandler: MenuHandler = {
  node: "ANN",

  async render(): Promise<View> {
    return renderAnnouncement();
  },

  async onAction(action, ctx, confirmed): Promise<View | null> {
    if (!action.startsWith("ann:")) return null;
    if (!can(ctx.admin, "operate")) {
      return { text: "⛔ Akses ditolak untuk aksi ini.", kb: (await renderAnnouncement()).kb };
    }

    if (action === "ann:on" || action === "ann:off") {
      const turnOn = action === "ann:on";
      if (!confirmed) {
        ctx.session.pending = { menu: "ANN", action };
        return {
          text: turnOn
            ? "Aktifkan banner pengumuman?\n\nSemua pengunjung melihat banner di atas halaman chat."
            : "Nonaktifkan banner pengumuman?\n\nBanner langsung hilang dari website.",
          kb: confirmKeyboard("✅ Ya, lanjut"),
        };
      }
      try {
        const ann = await getAnnouncement();
        await setAnnouncement({ ...ann, enabled: turnOn, updated_at: new Date().toISOString(), updated_by: ctx.admin.id });
        await auditLog({
          admin_id: ctx.admin.id,
          role: ctx.admin.role,
          action: turnOn ? "announcement.enabled" : "announcement.disabled",
          target: "site",
          result: "ok",
          detail: "",
        });
        const view = await renderAnnouncement();
        return { text: (turnOn ? "✅ Banner aktif." : "✅ Banner dinonaktifkan.") + "\n\n" + view.text, kb: view.kb };
      } catch {
        return { text: "❌ Operasi gagal — storage tidak bisa dihubungi.", kb: (await renderAnnouncement()).kb };
      }
    }

    if (action === "ann:set") {
      ctx.session.input = "ann_set";
      return {
        text: "Kirim judul & pesan pengumuman:\n\nJudul: ...\nPesan: ...\n\nKirim /menu untuk membatalkan.",
        kb: kb(BACK_MAIN),
      };
    }

    if (action === "ann:preview") {
      const ann = await getAnnouncement();
      return {
        text: `👁 Preview banner:\n\n[${ann.title}] ${ann.message}`,
        kb: (await renderAnnouncement()).kb,
      };
    }

    return null;
  },

  async onInput(text, ctx): Promise<View | null> {
    if (ctx.session.input !== "ann_set") return null;
    ctx.session.input = null;
    const title = (text.match(/^Judul:\s*(.+)$/m) || [])[1]?.trim();
    const message = (text.match(/^Pesan:\s*(.+)$/m) || [])[1]?.trim();
    if (!title && !message) {
      return { text: "Format belum benar — gunakan baris \"Judul: ...\" dan \"Pesan: ...\". Coba lagi dari menu.", kb: (await renderAnnouncement()).kb };
    }
    try {
      const ann = await getAnnouncement();
      await setAnnouncement({
        ...ann,
        title: (title || ann.title).slice(0, 80),
        message: (message || ann.message).slice(0, 300),
        updated_at: new Date().toISOString(),
        updated_by: ctx.admin.id,
      });
      await auditLog({
        admin_id: ctx.admin.id,
        role: ctx.admin.role,
        action: "announcement.message_changed",
        target: "announcement",
        result: "ok",
        detail: `title="${(title || ann.title).slice(0, 40)}"`,
      });
      const view = await renderAnnouncement();
      return { text: "✅ Pengumuman diperbarui.\n\n" + view.text, kb: view.kb };
    } catch {
      return { text: "❌ Operasi gagal — storage tidak bisa dihubungi.", kb: (await renderAnnouncement()).kb };
    }
  },
};
