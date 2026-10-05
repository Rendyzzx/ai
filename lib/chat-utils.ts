/* ============================================================
   Aomi — lib/chat-utils.ts
   Helper bersama client chat (port dari chat.js).
   ============================================================ */

import type { Message, DlCard, HdCard, MusicCard } from "@/types";
import { dlPlatformFromHost } from "@/lib/server/dl-platforms";

// API edit foto — browser menembak LANGSUNG (CORS terbuka), bebas dari
// batas 60 detik runtime server. API baru (xrina) balas gambar binary
// langsung; error balas JSON 500 (mis. "Insufficient credits").
export const EDIT_API = "https://apiii-xrina.vercel.app/ai-image/editimg";
export const EDIT_BROWSER_TIMEOUT = 120_000; // API eksternal ±40-60s saat inference
export const EDIT_RESULT_MAX = 4_000_000; // hasil maks 4MB

// API generate gambar (AI text2img) — browser menembak LANGSUNG (CORS
// terbuka), pola sama seperti edit foto: generate terukur ±30-40s,
// terlalu lama untuk ditunggu server (limit 60s).
export const IMG_GEN_API = "https://api-faa.my.id/faa/ai-text2img-pro";
export const IMG_GEN_TIMEOUT = 150_000; // API eksternal terukur ±30-60s

// Deteksi permintaan edit foto (gambar terlampir + kata pemicu).
// SALINAN dari EDIT_TRIGGER_RE di server — server tetap yang memutuskan
// rute; ini hanya memilih animasi loading yang tepat.
export const EDIT_TRIGGER_RE =
  /\b(edit(?:in|kan|ed|an)?|ubah(?:in)?|ganti(?:in)?|hias(?:in)?|rapikan|perjelas(?:kan)?|perbaiki(?:k)?(?:in|kan)?|hilangkan|hapus(?:in)?|tambah(?:in|kan)?|jadikan|warnain|warnai|warna(?:kan)?|colori[sz]e|retouch|remove|restore)\b/i;

/** Deteksi link downloader (animasi loading "downloading").
 *  Nilai baliknya cuma dipakai sebagai boolean oleh ChatApp — server
 *  tetap memutuskan rutenya. "dl" = platform tambahan (X/Twitter,
 *  Facebook, Spotify, dll — daftarnya di lib/server/dl-platforms). */
export function matchDlTarget(text: string): "tiktok" | "ig" | "dl" | null {
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
    if (dlPlatformFromHost(h)) return "dl";
  }
  return null;
}

/** Link YouTube (dipakai deteksi mode musik — server & client). */
export const YT_URL_RE =
  /https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?[^\s]*v=|shorts\/|embed\/|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i;

// Deteksi permintaan putar lagu: "tolong putarkan lagu X", "playkan X",
// "nyanyiin lagu X", "ganti lagu X", "putar <link YT>".
// SALINAN logika juga dipakai server (route chat) — server tetap yang
// memutuskan; ini memilih animasi loading yang tepat.
const MUSIC_VERB_RE =
  /(?:^|\s)(?:tolong(?:in)?\s+|coba\s+|bisa\s+|boleh\s+|mohon\s+|please\s+|pls\s+|aku\s+mau\s+|pengen\s+|mau\s+)?(?:(?:putar|putarke|nyanyi|play)(?:kan|ke|in|nya|ah)?|main(?:kan|ke|in|nya|ah))(?:\s+(?:lagu|musik|music|song|soundtrack|track)\b)?[\s:,]+(.+)$/i;
const MUSIC_CHANGE_RE =
  /(?:^|\s)(?:ganti(?:in)?|next|skip)\s+(?:lagu|musik|music|song)\s+(.+)$/i;
const MUSIC_FILLER_RE =
  /^(?:kan|ke|in|nya|ini|itu|dong|dulu|bukan|lagu(?:nya)?|musik(?:nya)?|music(?:nya)?|song|soundtrack|track)\b[\s:,]*/i;

/** Bersihkan query lagu dari kata sisa di sekitarnya. */
function cleanMusicQuery(raw: string): string {
  let q = raw.trim();
  for (let i = 0; i < 6; i++) {
    const next = q.replace(MUSIC_FILLER_RE, "");
    if (next === q) break;
    q = next;
  }
  return q
    .replace(/[\s,]+(?:dong|du|deh|ya+|banget|please|pls|makasih|thanks|thx)[\s.!]*$/i, "")
    .replace(/^[\s"'\u201C\u201D]+|[\s"'\u201C\u201D]+$/g, "")
    .replace(/[?!.]+$/, "")
    .trim();
}

// Deteksi permintaan generate gambar: "buatkan gambar X", "bikin
// gambar X", "generate gambar X", "gambarin X".
// SALINAN logika juga dipakai server (route chat) — server tetap yang
// memutuskan; ini memilih animasi loading yang tepat.
// Objek WAJIB ada kata "gambar"/"image"/dll untuk buat/bikin/generate
// (menghindari false positive "bikin kopi"); khusus "gambarin" cukup
// verb-nya sendiri.
const IMGGEN_OBJ_RE =
  /(?:^|\s)(?:tolong(?:in)?\s+|coba\s+|bisa\s+|boleh\s+|mohon\s+|please\s+|pls\s+|aku\s+mau\s+|pengen\s+|mau\s+)?(?:buat|bikin|generate|draw|paint|create)(?:kan|ke|in|nya|ah)?(?:\s+aku)?(?:\s+(?:se?buah|se?cuan|satu))?[\s,]*(?:gambar|image|ilustrasi|ilustration|poster|wallpaper|logo|art|drawing|painting|foto)\b[\s:,]+(.+)$/i;
const IMGGEN_VERB_RE =
  /(?:^|\s)(?:tolong(?:in)?\s+|coba\s+|bisa\s+|boleh\s+|mohon\s+|please\s+|pls\s+|aku\s+mau\s+|pengen\s+|mau\s+)?gambarin\b[\s:,]+(.+)$/i;

/** Bersihkan prompt dari sapaan/kata sisa di ujung. */
function cleanGenPrompt(raw: string): string {
  let q = raw.trim();
  for (let i = 0; i < 4; i++) {
    const next = q.replace(/^(?:yang|buat|bikin|gambarnya|gambarkan)\b[\s:,]*/i, "");
    if (next === q) break;
    q = next;
  }
  return q
    .replace(/[\s,]+(?:dong|du|deh|donk|ya+|banget|please|pls|makasih|thanks|thx)[\s.!]*$/i, "")
    .replace(/^["'\u201C]+|["'\u201D]+$/g, "")
    .replace(/[?!.]+$/, "")
    .trim();
}

/**
 * Balik prompt bila pesan adalah permintaan generate gambar,
 * selain itu null.
 */
export function matchImageGenRequest(raw: string): string | null {
  const text = String(raw || "").trim();
  if (!text || text.length > 500) return null;
  const m = text.match(IMGGEN_OBJ_RE) || text.match(IMGGEN_VERB_RE);
  if (!m) return null;
  const prompt = cleanGenPrompt(m[1] || "");
  if (!prompt || prompt.length < 2) return null;
  return prompt.slice(0, 300);
}

// Deteksi permintaan HD video: "hdkan <link>", "hd kan <link>", "jadiin hd", "bikin hd".
// Fix 2026-10: "hd" dan "kan"/"in" bisa dipisah spasi (bukan cuma strip)
// — sebelumnya "hd kan video ini" tidak terdeteksi dan nyasar ke chat biasa.
// SALINAN dari HD_TRIGGER_RE di server — server tetap yang memutuskan
// rute; ini hanya memilih animasi loading yang tepat.
export const HD_TRIGGER_RE =
  /\b(?:hdfy|hd[\s-]*kan|hd[\s-]*in|jadi(?:in|kan)?\s+hd|bikin(?:in|kan)?\s+hd|ubah(?:in)?\s+jadi\s+hd|upgrade(?:\s+ke)?\s+hd)\b/i;

/**
 * Balik URL video bila pesan adalah permintaan upgrade HD,
 * selain itu null. URL localhost/jaringan lokal ditolak.
 */
export function matchHdRequest(raw: string): string | null {
  const text = String(raw || "").trim();
  if (!text || text.length > 2000) return null;
  if (!HD_TRIGGER_RE.test(text)) return null;
  const urls = text.match(/https?:\/\/[^\s<>"')\]]+/gi) || [];
  for (const rawUrl of urls) {
    let u: URL;
    try {
      u = new URL(rawUrl.replace(/[.,;!?]+$/, ""));
    } catch {
      continue;
    }
    const h = u.hostname.toLowerCase();
    if (
      !h ||
      h === "localhost" ||
      h.endsWith(".local") ||
      /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)
    ) {
      continue;
    }
    return u.href;
  }
  return null;
}

/**
 * Balik query lagu bila pesan adalah permintaan putar lagu,
 * selain itu null. Query bisa judul lagu ATAU link YouTube.
 */
export function matchMusicRequest(raw: string): string | null {
  const text = String(raw || "").trim();
  if (!text || text.length > 300) return null;

  const m = text.match(MUSIC_VERB_RE) || text.match(MUSIC_CHANGE_RE);
  if (!m) return null;

  const query = cleanMusicQuery(m[1]);
  if (!query || query.length < 2) return null;
  return query.slice(0, 200);
}

/** Metadata kartu lagu. */
export function musicOf(m: Message): MusicCard | null {
  return m && m.music && typeof m.music === "object" && m.music.video_id && m.music.title
    ? m.music
    : null;
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

/** Metadata kartu HD video. */
export function hdOf(m: Message): HdCard | null {
  return m && m.hd && typeof m.hd === "object" && m.hd.job_id ? m.hd : null;
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
