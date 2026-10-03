/* ============================================================
   Aomi — lib/telegram/handlers/security.ts
   Security read-only + revoke sesi (owner, konfirmasi via pending
   state). Tidak ada secret yang pernah ditampilkan.
   ============================================================ */

import { can } from "../admin";
import { confirmKeyboard, securityMenu } from "../keyboards";
import { telegramSecurity, revokeAllSessions } from "@/lib/server/adminsvc";
import { auditLog } from "@/lib/server/audit";
import { fmtWIB } from "../format";
import type { Ctx, MenuHandler, View } from "./types";

export async function renderSecurity(): Promise<View> {
  const sec = await telegramSecurity().catch(() => null);
  const text = [
    "🔐 Security",
    "",
    "Percobaan akses bot tanpa izin:",
    sec
      ? `• Total: ${sec.unauthorized_count} kali\n• Terakhir: ${sec.last_attempt_at ? fmtWIB(sec.last_attempt_at) : "—"}${sec.last_id_masked ? ` (id ${sec.last_id_masked})` : ""}`
      : "• Tidak ada data tersimpan.",
    "",
    "Event rate-limit & keamanan lain dicatat di log server.",
    "",
    "Aksi tersedia di bawah — butuh konfirmasi.",
  ].join("\n");
  return { text, kb: securityMenu() };
}

export const securityHandler: MenuHandler = {
  node: "SEC",

  async render(): Promise<View> {
    return renderSecurity();
  },

  async onAction(action, ctx, confirmed): Promise<View | null> {
    if (action !== "sec:revoke") return null;
    if (!can(ctx.admin, "owner")) {
      return { text: "⛔ Akses ditolak untuk aksi ini (hanya OWNER).", kb: securityMenu() };
    }
    if (!confirmed) {
      ctx.session.pending = { menu: "SEC", action };
      return {
        text: "Revoke SEMUA sesi website?\n\nSemua user dipaksa login ulang. Sesi admin bot tidak terpengaruh.",
        kb: confirmKeyboard("🚫 Ya, revoke semua"),
      };
    }
    try {
      const n = await revokeAllSessions();
      await auditLog({
        admin_id: ctx.admin.id,
        role: ctx.admin.role,
        action: "security.sessions_revoked",
        target: "sessions",
        result: "ok",
        detail: `deleted=${n}`,
      });
      return { text: `✅ ${n} sesi dihapus. Semua user harus login ulang.`, kb: securityMenu() };
    } catch {
      return { text: "❌ Operasi gagal — storage tidak bisa dihubungi.", kb: securityMenu() };
    }
  },

  async onInput(): Promise<View | null> {
    return null;
  },
};
