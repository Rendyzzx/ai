/* ============================================================
   Aomi — lib/chat-utils.ts
   Helper bersama client chat (port dari chat.js).
   ============================================================ */

import type { Message, DlCard } from "@/types";

// API edit foto — browser menembak LANGSUNG (CORS terbuka), bebas dari
// batas 60 detik runtime server.
export const EDIT_API = "https://api-faa.my.id/faa/editfoto";
export const EDIT_BROWSER_TIMEOUT = 120_000; // API eksternal terukur ±40-60s
export const EDIT_RESULT_MAX = 4_000_000; // hasil maks 4MB

// Deteksi permintaan edit foto (gambar terlampir + kata pemicu).
// SALINAN dari EDIT_TRIGGER_RE di server — server tetap yang memutuskan
// rute; ini hanya memilih animasi loading yang tepat.
export const EDIT_TRIGGER_RE =
  /\b(edit(?:in|kan|ed|an)?|ubah(?:in)?|ganti(?:in)?|hias(?:in)?|rapikan|perjelas(?:kan)?|perbaiki(?:k)?(?:in|kan)?|hilangkan|hapus(?:in)?|tambah(?:in|kan)?|jadikan|warnain|warnai|warna(?:kan)?|colori[sz]e|retouch|remove|restore)\b/i;

/** Deteksi link TikTok/Instagram (untuk memilih animasi loading). */
export function matchDlTarget(text: string): "tiktok" | "ig" | null {
  const urls = String(text || "").match(/https?:\/\/[^\s<>"')\]]+/gi) || [];
  for (const raw of urls) {
    let u: URL;
    try {
      u = new URL(raw.replace(/[.,;!?]+$/, ""));
    } catch {
      continue;
    }
    const h = u.hostname.replace(/^www\./, "").toLowerCase();
    if (/(^|\.)tiktok\.com$/.test(h)) return "tiktok";
    if (/(^|\.)instagram\.com$/.test(h)) return "ig";
  }
  return null;
}

/** Metadata unduh pesan hasil edit. */
export function fileOf(m: Message): { url: string; name?: string | null; expiresAt?: string | null } | null {
  return m && typeof m.image_url === "string"
    ? { url: m.image_url, name: m.image_name, expiresAt: m.expires_at }
    : null;
}

/** Metadata kartu downloader. */
export function dlOf(m: Message): DlCard | null {
  return m && m.dl && typeof m.dl === "object" && (m.dl.video || m.dl.images || m.dl.music)
    ? m.dl
    : null;
}

/** Format waktu item riwayat (port dari sidebar.js). */
export function formatTime(iso: string): string {
  const t = Date.parse(iso || "");
  if (!iso || Number.isNaN(t)) return "";
  const d = new Date(t);
  const now = new Date();
  const oneDay = 86_400_000;
  if (now.getTime() - t < oneDay && d.getDate() === now.getDate()) return "Hari ini";
  const y = new Date(now.getTime() - oneDay);
  if (d.getDate() === y.getDate() && d.getMonth() === y.getMonth()) return "Kemarin";
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString("id-ID", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}
