/* ============================================================
   Aomi — lib/telegram/handlers/settings.ts
   Configuration: tampilan nilai penting (read-only) + pintasan ke
   fitur/pengumuman/pesan maintenance. TIDAK ada SET ENV mentah —
   semua perubahan lewat menu terstruktur + audit log.
   ============================================================ */

import { configMenu } from "../keyboards";
import { LIMITS } from "@/lib/server/limits";
import { APP_VERSION } from "@/lib/server/version";
import { getFlags } from "@/lib/server/features";
import type { Ctx, MenuHandler, View } from "./types";

export async function renderConfig(): Promise<View> {
  const env = process.env.VERCEL_ENV || process.env.NODE_ENV || "unknown";
  const storage = process.env.UPSTASH_REDIS_REST_URL ? "Upstash Redis" : "GitHub fallback";
  return {
    text: [
      "⚙️ Configuration",
      "",
      `Environment: ${env}`,
      `Version: ${APP_VERSION}`,
      `Storage utama: ${storage}`,
      "",
      "Perubahan konfigurasi (pengumuman, fitur, pesan maintenance) lewat menu masing-masing — selalu dengan audit log. Env mentah tidak bisa diubah dari bot.",
    ].join("\n"),
    kb: configMenu(),
  };
}

export const settingsHandler: MenuHandler = {
  node: "CFG",

  async render(): Promise<View> {
    return renderConfig();
  },

  async onAction(action): Promise<View | null> {
    if (action !== "cfg:limits") return null;
    const flags = await getFlags();
    return {
      text: [
        "📏 Limits & Konfigurasi aktif (read-only)",
        "",
        `Panjang pesan maks: ${LIMITS.messageMaxLen} karakter`,
        `Balasan AI maks: ${LIMITS.responseMaxLen} karakter`,
        `Pesan per percakapan: ${LIMITS.maxMessages}`,
        `Timeout AI: ${LIMITS.geminiTimeout / 1000} detik`,
        `Hasil edit/generate maks: ${LIMITS.editResultMax / 1_000_000} MB`,
        `TTL gambar sementara: ${LIMITS.tempResultTtl / 86400} hari`,
        "",
        `Feature flags ON: ${Object.entries(flags).filter(([, on]) => on).map(([n]) => n).join(", ") || "—"}`,
      ].join("\n"),
      kb: (await renderConfig()).kb,
    };
  },

  async onInput(): Promise<View | null> {
    return null;
  },
};
