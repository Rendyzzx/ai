/* ============================================================
   Aomi — lib/telegram/handlers/features.ts
   Menu AI & Tools = feature flags. Toggle dicek DI SERVER
   (route API), bukan cuma sembunyi tombol. Toggle selalu
   lewat konfirmasi.
   ============================================================ */

import { can } from "../admin";
import { confirmKeyboard, featureMenu } from "../keyboards";
import { FEATURE_NAMES, featureLabel, getFlags, setFlag, type FeatureName } from "@/lib/server/features";
import { auditLog } from "@/lib/server/audit";
import type { Ctx, MenuHandler, View } from "./types";

const flagEmoji = (b: boolean) => (b ? "🟢 Enabled" : "🔴 Disabled");

export async function renderFeatures(): Promise<View> {
  const flags = await getFlags();
  const lines = FEATURE_NAMES.map((n) => `• ${featureLabel(n)} (${n}): ${flagEmoji(flags[n])}`);
  return {
    text: ["🤖 AI & Tools — Feature Flags", "", ...lines, "", "Toggle akan konfirmasi dulu. Flag dicek di server (bukan cuma UI)."].join("\n"),
    kb: featureMenu(),
  };
}

export const featuresHandler: MenuHandler = {
  node: "FEAT",

  async render(): Promise<View> {
    return renderFeatures();
  },

  async onAction(action, ctx, confirmed): Promise<View | null> {
    const m = action.match(/^feat:([a-z-]+)$/);
    if (!m) return null;
    const name = m[1] as FeatureName;
    if (!(FEATURE_NAMES as readonly string[]).includes(name)) return null;
    if (!can(ctx.admin, "operate")) {
      return { text: "⛔ Akses ditolak untuk aksi ini.", kb: (await renderFeatures()).kb };
    }
    const flags = await getFlags();
    const next = !flags[name];

    if (!confirmed) {
      ctx.session.pending = { menu: "FEAT", action };
      return {
        text: next
          ? `Aktifkan fitur "${featureLabel(name)}"?\n\nFitur bisa dipakai semua user lagi.`
          : `Nonaktifkan fitur "${featureLabel(name)}"?\n\nFitur ditolak DI SERVER — user yang meminta fitur ini ditolak dengan pesan.`,
        kb: confirmKeyboard(next ? "✅ Ya, aktifkan" : "🔴 Ya, nonaktifkan"),
      };
    }

    try {
      const updated = await setFlag(name, next);
      if (!updated) return { text: "Flag tidak dikenal.", kb: (await renderFeatures()).kb };
      await auditLog({
        admin_id: ctx.admin.id,
        role: ctx.admin.role,
        action: "feature.toggled",
        target: `flag:${name}`,
        result: "ok",
        detail: `enabled=${next}`,
      });
      const view = await renderFeatures();
      return {
        text: `✅ Fitur "${featureLabel(name)}" sekarang ${flagEmoji(next)}.\n\n` + view.text,
        kb: view.kb,
      };
    } catch {
      return { text: "❌ Operasi gagal — storage tidak bisa dihubungi.", kb: (await renderFeatures()).kb };
    }
  },

  async onInput(): Promise<View | null> {
    return null;
  },
};
