/* ============================================================
   Aomi — lib/telegram/handlers/maintenance.ts
   Menu maintenance: aktif/nonaktif (konfirmasi), ubah pesan,
   jadwal (dievaluasi saat dibaca — tanpa setTimeout permanen),
   dan preview.
   ============================================================ */

import { can } from "../admin";
import { confirmKeyboard, maintenanceMenu, BACK_MAIN } from "../keyboards";
import type { TgInlineKeyboard } from "../types";
import {
  getMaintenanceState,
  setMaintenanceState,
  getMaintenanceConfig,
  setMaintenanceConfig,
} from "@/lib/server/maintenance";
import { DEFAULT_MAINTENANCE_CONFIG, parseScheduleInput } from "@/lib/server/maintenance-pure";
import { auditLog } from "@/lib/server/audit";
import { fmtWIB } from "../format";
import type { Ctx, MenuHandler, View } from "./types";

const kb = (rows: [string, string][][]): TgInlineKeyboard => ({
  inline_keyboard: rows.map((r) => r.map(([text, data]) => ({ text, callback_data: data }))),
});

export async function renderMaintenance(): Promise<View> {
  const [state, cfg] = await Promise.all([getMaintenanceState(), getMaintenanceConfig()]);
  const active = state.mode === "on" || state.mode === "scheduled";
  const sched =
    state.mode === "scheduled"
      ? `\nJadwal: ${fmtWIB(state.scheduled_start)} → ${fmtWIB(state.scheduled_end)}`
      : "";
  return {
    text: [
      "🛠 Maintenance",
      "",
      `Status: ${active ? "🟠 ON" : "🟢 OFF"}${sched}`,
      `Judul: ${cfg.title}`,
      `Pesan: ${cfg.message}`,
      cfg.eta ? `Estimasi: ${cfg.eta}` : "",
      "",
      "Aktifkan = semua user diarahkan ke halaman /maintenance.",
    ]
      .filter((l) => l !== "")
      .join("\n"),
    kb: maintenanceMenu(active),
  };
}

export const maintenanceHandler: MenuHandler = {
  node: "MAINT",

  async render(): Promise<View> {
    return renderMaintenance();
  },

  async onAction(action, ctx, confirmed): Promise<View | null> {
    if (!action.startsWith("maint:")) return null;
    if (!can(ctx.admin, "operate")) {
      return { text: "⛔ Akses ditolak untuk aksi ini.", kb: (await renderMaintenance()).kb };
    }

    if (action === "maint:on" || action === "maint:off") {
      const turnOn = action === "maint:on";
      if (!confirmed) {
        ctx.session.pending = { menu: "MAINT", action };
        return {
          text: turnOn
            ? "Aktifkan maintenance?\n\nWebsite akan menampilkan halaman maintenance kepada semua user. Kamu tetap bisa mematikannya lewat bot ini."
            : "Nonaktifkan maintenance?\n\nWebsite langsung bisa diakses kembali.",
          kb: confirmKeyboard("✅ Ya, lanjut"),
        };
      }
      try {
        const state = await getMaintenanceState();
        await setMaintenanceState({
          ...state,
          mode: turnOn ? "on" : "off",
          updated_at: new Date().toISOString(),
          updated_by: ctx.admin.id,
        });
        await auditLog({
          admin_id: ctx.admin.id,
          role: ctx.admin.role,
          action: turnOn ? "maintenance.enabled" : "maintenance.disabled",
          target: "site",
          result: "ok",
          detail: turnOn ? "mode=on" : "mode=off",
        });
        const view = await renderMaintenance();
        return {
          text: (turnOn ? "✅ Maintenance aktif." : "✅ Maintenance dinonaktifkan.") + "\n\n" + view.text,
          kb: view.kb,
        };
      } catch {
        return {
          text: "❌ Operasi gagal — storage tidak bisa dihubungi. Tidak ada yang diubah.",
          kb: (await renderMaintenance()).kb,
        };
      }
    }

    if (action === "maint:msg") {
      ctx.session.input = "maint_msg";
      return {
        text:
          "Kirim pesan maintenance baru dalam format:\n\nJudul: ...\nPesan: ...\nEstimasi: ... (opsional)\n\nKirim /menu untuk membatalkan.",
        kb: kb(BACK_MAIN),
      };
    }

    if (action === "maint:sched") {
      ctx.session.input = "maint_sched";
      return {
        text:
          "Kirim jadwal maintenance (WIB):\n\nYYYY-MM-DD HH:mm-HH:mm\n\nContoh: 2026-10-05 02:00-03:00\n\nMaintenance aktif otomatis di jadwal dan selesai otomatis. Kirim /menu untuk membatalkan.",
        kb: kb(BACK_MAIN),
      };
    }

    if (action === "maint:preview") {
      const cfg = await getMaintenanceConfig();
      return {
        text: `👁 Preview halaman /maintenance:\n\n${cfg.title}\n\n${cfg.message}${cfg.eta ? `\n\nPerkiraan selesai: ${cfg.eta}` : ""}`,
        kb: (await renderMaintenance()).kb,
      };
    }

    return null;
  },

  async onInput(text, ctx): Promise<View | null> {
    if (ctx.session.input === "maint_msg") {
      ctx.session.input = null;
      const title = (text.match(/^Judul:\s*(.+)$/m) || [])[1]?.trim();
      const message = (text.match(/^Pesan:\s*(.+)$/m) || [])[1]?.trim();
      const eta = (text.match(/^Estimasi:\s*(.+)$/m) || [])[1]?.trim() || "";
      if (!message) {
        return {
          text: "Format belum benar — baris \"Pesan: ...\" wajib ada. Silakan coba lagi dari menu.",
          kb: (await renderMaintenance()).kb,
        };
      }
      try {
        const cfg = await getMaintenanceConfig();
        await setMaintenanceConfig({
          title: title || cfg.title || DEFAULT_MAINTENANCE_CONFIG.title,
          message: message.slice(0, 500),
          eta: eta.slice(0, 120),
          updated_at: new Date().toISOString(),
          updated_by: ctx.admin.id,
        });
        await auditLog({
          admin_id: ctx.admin.id,
          role: ctx.admin.role,
          action: "maintenance.message_changed",
          target: "maintenance/config",
          result: "ok",
          detail: `title="${(title || DEFAULT_MAINTENANCE_CONFIG.title).slice(0, 40)}"`,
        });
        const view = await renderMaintenance();
        return { text: "✅ Pesan maintenance diperbarui.\n\n" + view.text, kb: view.kb };
      } catch {
        return { text: "❌ Operasi gagal — storage tidak bisa dihubungi.", kb: (await renderMaintenance()).kb };
      }
    }

    if (ctx.session.input === "maint_sched") {
      ctx.session.input = null;
      const parsed = parseScheduleInput(text);
      if (!parsed) {
        return {
          text: "Format jadwal tidak valid. Gunakan: YYYY-MM-DD HH:mm-HH:mm (WIB). Silakan coba lagi dari menu.",
          kb: (await renderMaintenance()).kb,
        };
      }
      try {
        const state = await getMaintenanceState();
        await setMaintenanceState({
          ...state,
          mode: "scheduled",
          scheduled_start: parsed.start,
          scheduled_end: parsed.end,
          updated_at: new Date().toISOString(),
          updated_by: ctx.admin.id,
        });
        await auditLog({
          admin_id: ctx.admin.id,
          role: ctx.admin.role,
          action: "maintenance.scheduled",
          target: "site",
          result: "ok",
          detail: `${parsed.start} s/d ${parsed.end}`,
        });
        const view = await renderMaintenance();
        return { text: "✅ Jadwal maintenance disimpan.\n\n" + view.text, kb: view.kb };
      } catch {
        return { text: "❌ Operasi gagal — storage tidak bisa dihubungi.", kb: (await renderMaintenance()).kb };
      }
    }

    return null;
  },
};
