// ============================================================
// Aomi — /api/chat (Route Handler)
// Port dari api/chat.js — behavior identik.
//
// Arsitektur: Browser → route ini (session wajib) → Provider AI
//             → pesan tersimpan ke storage per user.
// Provider: Gemini (scraping internal, tanpa API key).
// ============================================================

import crypto from "node:crypto";
import { readJson, putJson, updateJson, expireJson } from "@/lib/server/store";
import { DEFAULT_BOT } from "@/lib/server/bot-config";
import { getSession } from "@/lib/server/auth";
import { allowUser } from "@/lib/server/ratelimit";
import { json, readBody, forbidden, originOk } from "@/lib/server/http";
import { matchMusicRequest, matchImageGenRequest, matchHdRequest, HD_TRIGGER_RE } from "@/lib/chat-utils";
import { resolveMusicCard, MusicError } from "@/lib/server/music";
import { submitHdJob, HdError } from "@/lib/server/hdvid";
import { UPLOAD_HOST_RE } from "@/lib/server/uup";
import { upscalePhoto, fetchUpscaledBytes, HdPhotoError } from "@/lib/server/hdphoto";
import { LIMITS } from "@/lib/server/limits";
import { maintenanceBlockResponse } from "@/lib/server/maintenance";
import { getFlags } from "@/lib/server/features";
import { isUserSuspended } from "@/lib/server/adminsvc";
import type { BotConfig, Conversation, ConversationItem, DlCard, HdCard, Message } from "@/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;


const HOSTS = {
  geminiCookie: "https://gemini.google.com/_/BardChatUi/data/batchexecute",
  geminiChat:
    "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate",
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0";

const TONE_PROMPTS: Record<string, string> = {
  casual: "Formalitas bicaramu: santai seperti teman dekat.",
  neutral: "Formalitas bicaramu: netral dan lugas.",
  formal: "Formalitas bicaramu: sedikit lebih sopan, tapi tetap personal.",
};

const LENGTH_PROMPTS: Record<string, string> = {
  concise: "Balasanmu SANGAT singkat — beberapa kata sampai satu kalimat.",
  balanced: "Balasanmu ringkas: satu-tiga kalimat, kecuali topiknya butuh lebih.",
  detailed: "Kamu boleh menulis lebih panjang, tapi tetap seperti obrolan, bukan artikel.",
};

const TRAIT_PROMPTS: Record<string, string> = {
  calm: "tenang, tidak gampang panik, menenangkan",
  playful: "playful — suka bercanda dan menghibur",
  teasing: "suka menggoda dan mengerjai dengan ringan (sewa-waktu, bukan jahat)",
  caring: "peduli; memperhatikan perasaan dan kabar orang",
  shy: "pemalu dan sedikit canggung, tapi hangat kalau sudah dekat",
  energetic: "energik, antusias, gampang excited",
  sarcastic: "sarkastis dan receh, tapi tetap sayang",
  affectionate: "lembut dan ekspresif soal perasaan, mesra secara platonik atau romantis",
  reserved: "pendiam, pemilih kata, tidak bertele-tele",
};

const SPEAKING_PROMPTS: Record<string, string> = {
  casual: "Gaya bicaramu: santai, seperti chat teman dekat. Boleh lowercase.",
  short: "Gaya bicaramu: super singkat. Satu kalimat pendek atau beberapa kata saja, seperti orang malas ngetik.",
  expressive: 'Gaya bicaramu: ekspresif. Boleh tanda seru, kata kuat, "wkwk", "aduhhh".',
  dry: "Gaya bicaramu: datar, humor kering, sedikit kata.",
  playful: "Gaya bicaramu: playful — candaan, tebakan iseng, pertanyaan balik yang jail.",
  detailed: "Gaya bicaramu: suka menambah detail kecil dan cerita, tapi tetap seperti ngobrol.",
};

const RELATIONSHIP_PROMPTS: Record<string, string> = {
  close_friend: "Kamu dan pengguna adalah sahabat dekat yang sudah lama saling kenal.",
  companion: "Kamu adalah companion personal pengguna — selalu ada buat dia, kapan pun dia butuh.",
  fictional: "Kamu adalah karakter fiksi dengan latar dan ceritamu sendiri.",
  romantic: "Kamu dan pengguna punya dinamika romantis: mesra, perhatian, dan hangat.",
};

const GREETING_FALLBACKS: Record<string, string[]> = {
  playful: ["oh, kamu dateng. aku udah nungguin dari tadi tau."],
  teasing: ["yeaah akhirnya muncul juga. kira-kira kabur selamanya."],
  caring: ["hey, kamu! udah lama nggak ketemu. kabarmu baik semua ya?"],
  shy: ["um... hi. seneng kamu mampir."],
  calm: ["hey. santai aja, gak ada buru-buru."],
  energetic: ["KAMU GILAA- eh maksudnya. hi! ada apa hari ini?"],
  sarcastic: ["wow, sinyal hidup terdeteksi. hai juga."],
  affectionate: ["hey kamu. aku kangen. cerita dong, gimana harimu?"],
  reserved: ["...oh. kamu lagi."],
  default: ["hey. kamu akhirnya muncul."],
};

// System prompt dari konfigurasi karakter (identitas, sifat, gaya bicara,
// hubungan, memori) — bukan "kamu adalah asisten AI".
function buildInstruction(bot: BotConfig): string {
  const name = bot.bot_name || "Aomi";
  const parts: string[] = [];
  parts.push(
    `Kamu adalah ${name}, karakter virtual yang sedang mengobrol secara personal dengan satu orang lewat aplikasi chat. ` +
      "Kamu BUKAN asisten AI, BUKAN customer service, dan BUKAN alat produktivitas."
  );
  if (bot.bot_description) parts.push(`Deskripsimu: ${bot.bot_description}.`);

  const traits =
    Array.isArray(bot.traits) && bot.traits.length
      ? bot.traits.map((t) => TRAIT_PROMPTS[t]).filter(Boolean)
      : ["hangat, ramah, dan perhatian"];
  parts.push(`Kepribadianmu: ${traits.join("; ")}.`);
  parts.push(SPEAKING_PROMPTS[bot.speaking_style] || SPEAKING_PROMPTS.casual);
  parts.push(RELATIONSHIP_PROMPTS[bot.relationship] || RELATIONSHIP_PROMPTS.companion);

  if (bot.likes) parts.push(`Hal yang kamu sukai: ${bot.likes}.`);
  if (bot.avoids) parts.push(`Hal yang kamu hindari: ${bot.avoids}.`);
  if (bot.personality) parts.push(`Catatan kepribadian tambahan darimu: ${bot.personality}`);

  const mems = (Array.isArray(bot.memories) ? bot.memories : []).filter(Boolean);
  if (mems.length) {
    parts.push(
      "Hal-hal yang kamu ingat tentang pengguna: " +
        mems.map((m) => `(${m})`).join(" ") +
        ". Sebut secara alami kalau relevan, jangan seperti membaca daftar."
    );
  }

  if (bot.language === "en") parts.push("Always reply in English.");
  else if (bot.language === "id")
    parts.push(
      "Selalu berbahasa Indonesia gaul dan santai — bahasa ngobrol sehari-hari " +
        '(boleh singkatan kayak "gak", "udah", "sih"), JANGAN bahasa baku/formal.'
    );
  else parts.push("Balas pakai bahasa yang dipakai pengguna.");

  parts.push(TONE_PROMPTS[bot.response_style] || TONE_PROMPTS.casual);
  parts.push(LENGTH_PROMPTS[bot.response_length] || LENGTH_PROMPTS.balanced);

  parts.push(
    "Aturan bicara: " +
      "(1) Ngobrol seperti manusia sungguhan lewat chat: kalimat pendek, natural, kadang tidak lengkap. " +
      '(2) JANGAN PERNAH pakai gaya asisten: "Ada yang bisa dibantu?", "Tentu saja!", "Certainly!", "Of course!", "I would be happy to help", "Sebagai AI...". ' +
      "(3) Jangan menawarkan bantuan tanpa diminta — kalian sedang ngobrol, bukan sesi layanan. " +
      "(4) Jangan sebut dirimu AI/bot/asisten/model bahasa kecuali pengguna bertanya langsung. " +
      "(5) Jangan gunakan format markdown berat."
  );

  // Pengetahuan fitur aplikasi — kalau pengguna nanya "di sini fiturnya
  // apa aja?" / "kamu bisa apa?", jelasin santai pakai gaya bicaramu
  // sendiri (tetap konsisten karakter, bukan gaya customer service).
  parts.push(
    "Fitur aplikasi chat tempat kamu mengobrol (semuanya kamu yang jalankan, jadi bilang 'aku bisa...'): " +
      "(1) Ngobrol santai kapan aja. " +
      "(2) Download video TikTok/Instagram: kirim link videonya, hasilnya langsung bisa diunduh tanpa watermark. " +
      "(3) Lagu plus lirik: kirim link YouTube atau tulis aja kayak 'putarkan lagu X', lagunya muncul lengkap sama liriknya. " +
      "(4) Bikin gambar: tulis 'bikin gambar X' atau 'gambarin X' dengan deskripsi bebas. " +
      "(5) Edit foto: kirim fotonya bareng instruksi, contoh 'ubah jadi anime' atau 'perjelas foto ini'. " +
      "(6) Upgrade HD: bilang 'hdkan' — kirim link video buat videonya dinaikin ke HD, atau kirim foto buat resolusinya di-upscale jadi 4x lebih tajam. " +
      "(7) Lihat gambar/video: kirim fotonya atau videonya terus tanya apa aja soal isinya, bakal dijelasin. " +
      "Kalau pengguna nanya soal fitur atau kemampuan (contoh: 'di sini fiturnya apa aja?', 'kamu bisa apa aja?', 'ada fitur apa?'), " +
      "sebut fitur di atas satu-satu dengan gaya ngobrolmu, kasih contoh cara pakainya yang singkat, " +
      "dan ajak dia cobain salah satu. Jangan baca seperti daftar kaku dan jangan pakai gaya customer service."
  );

  if (bot.system_prompt) parts.push(bot.system_prompt);
  return parts.join(" ");
}

// Instruksi khusus sapaan pertama (karakter membuka chat duluan)
function greetingInstruction(bot: BotConfig): string {
  const traits = Array.isArray(bot.traits) ? bot.traits : [];
  const base = buildInstruction(bot);
  return (
    base +
    " Sekarang PESAN PERTAMA: pengguna baru saja membuka chat dan belum menulis apa pun. " +
    "Kirim sapaan pembuka sesuai kepribadianmu — satu sampai dua kalimat pendek saja, " +
    "seperti membuka chat dengan orang yang kamu tunggu. Jangan perkenalan formal, " +
    'jangan menawarkan bantuan, jangan tanya "ada yang bisa dibantu".' +
    (traits.length ? ` Sapaan harus terasa khas sifat: ${traits.join(", ")}.` : "")
  );
}

// ---------------- Util ----------------

async function fetchT(
  url: string,
  options: RequestInit = {},
  timeoutMs: number,
  maxBytes = LIMITS.fetchBytes
): Promise<{ status: number; headers: Headers; text: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      text: text.length > maxBytes ? text.slice(0, maxBytes) : text,
    };
  } finally {
    clearTimeout(timer);
  }
}

function sanitize(str: unknown, maxLen: number): string {
  return String(str ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .slice(0, maxLen);
}

// ---------------- PROVIDER — Gemini (scraping) ----------------

interface GeminiSession {
  resumeArray: unknown[] | null;
  cookie: string | null;
  instruction: string;
}

function decodeSessionId(sessionId: string): GeminiSession {
  try {
    const data = JSON.parse(Buffer.from(sessionId, "base64").toString());
    if (data && Array.isArray(data.resumeArray)) {
      return {
        resumeArray: data.resumeArray,
        cookie: typeof data.cookie === "string" ? data.cookie : null,
        instruction: typeof data.instruction === "string" ? data.instruction : "",
      };
    }
  } catch {
    /* sessionId rusak → mulai baru */
  }
  return { resumeArray: null, cookie: null, instruction: "" };
}

function encodeSessionId(resumeArray: unknown[], cookie: string, instruction: string): string {
  return Buffer.from(JSON.stringify({ resumeArray, cookie, instruction })).toString("base64");
}

async function geminiGetCookie(): Promise<string> {
  const res = await fetchT(
    HOSTS.geminiCookie +
      "?rpcids=maGuAc&source-path=%2F&bl=boq_assistant-bard-web-server_20250814.06_p1" +
      "&f.sid=-7816331052118000090&hl=en-US&_reqid=173780&rt=c",
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        "user-agent": UA,
      },
      body: "f.req=%5B%5B%5B%22maGuAc%22%2C%22%5B0%5D%22%2Cnull%2C%22generic%22%5D%5D%5D&",
    },
    LIMITS.geminiTimeout
  );
  const raw = res.headers.getSetCookie?.() || [];
  const cookie = (raw[0] || "").split("; ")[0] || "";
  if (!cookie) throw new Error("cookie kosong");
  return cookie;
}

// Upload file (gambar/frame video) ke Google content-push → media key.
// Tanpa cookie akun. Flow 2026: POST start (dapat upload URL) lalu
// POST bytes (upload, finalize). Nama file ikut dikirim di body start.
const UPLOAD_BASIC = "c2F2ZXM6cyNMdGhlNmxzd2F2b0RsN3J1d1U=";
const UPLOAD_PUSH_ID = "feeds/mcudyrk2a4khkz";

async function uploadImageGemini(buffer: Buffer, name: string): Promise<string> {
  const baseHeaders: Record<string, string> = {
    "authorization": "Basic " + UPLOAD_BASIC,
    "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
    "origin": "https://gemini.google.com",
    "referer": "https://gemini.google.com/",
    "push-id": UPLOAD_PUSH_ID,
    "x-goog-upload-protocol": "resumable",
    "x-goog-upload-command": "start",
    "x-tenant-id": "bard-storage",
    "user-agent": UA,
    "x-goog-upload-header-content-length": String(buffer.length),
    "size": String(buffer.length),
  };

  // Langkah 1: minta upload URL
  const startRes = await fetchT("https://content-push.googleapis.com/upload/", {
    method: "POST",
    headers: baseHeaders,
    body: "File name: " + name,
  }, LIMITS.geminiTimeout);
  const uploadUrl = startRes.headers.get("x-goog-upload-url") || "";
  if (!uploadUrl) throw new Error("upload url kosong (" + startRes.status + ")");

  // Langkah 2: dorong bytes → media key
  const res = await fetchT(uploadUrl, {
    method: "POST",
    headers: {
      ...baseHeaders,
      "x-goog-upload-command": "upload, finalize",
      "x-goog-upload-offset": "0",
    },
    body: new Uint8Array(buffer),
  }, LIMITS.geminiTimeout);
  const key = res.text.trim();
  if (!key || key.length > 200) throw new Error("media key kosong");
  return key;
}

// Satu percobaan request ke Gemini dengan resumeArray tertentu.
async function sendGeminiRequest(
  firstMsg: unknown[],
  resumeArray: unknown[] | null,
  cookie: string,
  instruction: string
): Promise<unknown[]> {
  const requestBody = [
    firstMsg,
    ["en-US"],
    resumeArray || ["", "", "", null, null, null, null, null, null, ""],
    null, null, null, [1], 1, null, null, 1, 0, null, null, null, null, null,
    [[0]], 1, null, null, null, null, null,
    ["", "", instruction, null, null, null, null, null, 0, null, 1, null, null, null, []],
    null, null, 1, null, null, null, null, null, null, null,
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
    1, null, null, null, null, [1],
  ];
  const payload = [null, JSON.stringify(requestBody)];

  const res = await fetchT(
    HOSTS.geminiChat +
      "?bl=boq_assistant-bard-web-server_20250729.06_p0&f.sid=4206607810970164620" +
      "&hl=en-US&_reqid=2813378&rt=c",
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        "x-goog-ext-525001261-jspb":
          '[1,null,null,null,"9ec249fc9ad08861",null,null,null,[4]]',
        cookie,
        "user-agent": UA,
      },
      body: new URLSearchParams({ "f.req": JSON.stringify(payload) }).toString(),
    },
    LIMITS.geminiTimeout
  );

  const match = Array.from(res.text.matchAll(/^\d+\n(.+?)\n/gm)).reverse();
  for (const item of match) {
    try {
      const outer = JSON.parse(item[1]);
      const candidate = outer?.[0]?.[2];
      if (!candidate) continue;
      const inner = JSON.parse(candidate);
      if (inner?.[4]?.[0]?.[1]?.[0]) return inner;
    } catch {
      /* lewati chunk non-JSON */
    }
  }
  throw new Error("parsing gemini gagal");
}

// Ringkasan percakapan terakhir — dipakai saat thread Gemini restart
// agar karakter tetap "ingat" konteks obrolan.
function buildRecap(messages: Message[]): string {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const recent = messages.slice(-6).filter((m) => m && m.content);
  if (recent.length === 0) return "";
  const lines = recent.map((m) => (m.role === "user" ? "User" : "Kamu") + ": " + String(m.content).slice(0, 300));
  return (
    "[Ingat, ini lanjutan obrolan kalian sebelumnya — jangan menyapa seolah baru kenal]\n" +
    lines.join("\n")
  );
}

interface ChatInput {
  message: string;
  geminiSessionId: string | null;
  messages: Message[];
  imageBuffer: Buffer | null;
  imageName: string | null;
  imageDataUrl?: string | null;
  frameBuffers?: Buffer[];   // frame video (dataURL dari client)
  videoInfo?: { name: string; size: number } | null;
}

async function chatGemini(
  input: ChatInput,
  instruction: string
): Promise<{ text: string; geminiSessionId: string }> {
  let { resumeArray, cookie } = input.geminiSessionId
    ? decodeSessionId(input.geminiSessionId)
    : { resumeArray: null, cookie: null };

  if (!cookie) cookie = await geminiGetCookie();

  // Lampiran (Gemini vision): upload → media key → posisi 4 pada array
  // pesan. Gambar tunggal ATAU beberapa frame video. Gagal upload →
  // chat tetap jalan teks saja (graceful).
  const firstMsg: unknown[] = [input.message, 0, null, null, null, null, 0];
  const attachments: Array<[[string, number], string]> = [];
  const notes: string[] = [];
  try {
    if (input.imageBuffer) {
      const key = await uploadImageGemini(input.imageBuffer, input.imageName || "image.jpg");
      attachments.push([[key, 1], input.imageName || "image.jpg"]);
    }
    for (let i = 0; i < (input.frameBuffers?.length || 0); i++) {
      const frame = input.frameBuffers![i];
      const fname = "frame-" + (i + 1) + ".jpg";
      const key = await uploadImageGemini(frame, fname);
      attachments.push([[key, 1], fname]);
    }
    if (attachments.length) firstMsg[3] = attachments;
    if (input.frameBuffers?.length) {
      notes.push(
        "pengguna mengirim video: '" + (input.videoInfo?.name || "video") + "' " +
        (input.videoInfo ? Math.round(input.videoInfo.size / 1024) + "KB" : "") +
        ". Lampiran gambar berikut adalah FRAME-FRAME dari video itu " +
        "(berurutan dari awal ke akhir video) — perlakukan sebagai isi videonya."
      );
    }
  } catch (err) {
    console.error("[chat] upload lampiran gemini:", (err as Error).message);
    notes.push(
      input.frameBuffers?.length
        ? "(pengguna mengirim video, tapi lampirannya gagal dikirim — jawab dari konteks teks saja)"
        : "(pengguna mengirim gambar, tapi gagal dilampirkan — jawab dari konteks teks saja)"
    );
  }
  if (notes.length) {
    input = { ...input, message: input.message + "\n(" + notes.join(" ") + ")" };
    firstMsg[0] = input.message;
  }

  // Google menolak thread setelah ada giliran bergambar (BardErrorInfo 1097)
  // → retry SEKALI dengan thread baru + recap supaya karakter "tetap ingat".
  let parsed: unknown[];
  try {
    parsed = await sendGeminiRequest(firstMsg, resumeArray, cookie, instruction);
  } catch (err) {
    if (!resumeArray) throw err; // thread baru pun gagal → bukan masalah resume
    console.warn("[chat] resume gemini gagal, mulai thread baru dgn konteks:", (err as Error).message);
    resumeArray = null;

    const recap = buildRecap(input.messages);
    const healedMsg = recap
      ? [recap + "\n\n" + firstMsg[0], ...firstMsg.slice(1)]
      : firstMsg;
    parsed = await sendGeminiRequest(healedMsg, null, cookie, instruction);
  }

  const arr = parsed as unknown[];
  const deep = (x: unknown) => x as unknown[];
  const resume = [...deep(arr[1]), (deep(deep(arr[4])[0] as unknown)[0] as unknown)];
  const text = String(deep(deep(deep(arr[4])[0] as unknown)[1] as unknown)[0])
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/\[cite:\s*\d+(?:,\s*\d+)*\]/gi, "")
    .trim();
  return {
    text: text.slice(0, LIMITS.responseMaxLen),
    geminiSessionId: encodeSessionId(resume as unknown[], cookie, instruction),
  };
}

// ---------------- Deteksi edit foto (SALINAN regex ada di client) ----------------

const EDIT_TRIGGER_RE =
  /\b(edit(?:in|kan|ed|an)?|ubah(?:in)?|ganti(?:in)?|hias(?:in)?|rapikan|perjelas(?:kan)?|perbaiki(?:k)?(?:in|kan)?|hilangkan|hapus(?:in)?|tambah(?:in|kan)?|jadikan|warnain|warnai|warna(?:kan)?|colori[sz]e|retouch|remove|restore)\b/i;

// ---------------- MODE DOWNLOADER (TikTok / Instagram) ----------------

const DL_TIKTOK_API = "https://api-faa.my.id/faa/tiktok";
const DL_IG_API = "https://api-faa.my.id/faa/igdl";

function matchDownloadTarget(text: string): { platform: "tiktok" | "ig"; url: string } | null {
  const urls = String(text || "").match(/https?:\/\/[^\s<>"')\]]+/gi) || [];
  for (const raw of urls) {
    let u: URL;
    try {
      u = new URL(raw.replace(/[.,;!?]+$/, ""));
    } catch {
      continue;
    }
    const h = u.hostname.replace(/^www\./, "").toLowerCase();
    if (/(^|\.)tiktok\.com$/.test(h)) return { platform: "tiktok", url: u.href };
    if (/(^|\.)instagram\.com$/.test(h)) return { platform: "ig", url: u.href };
  }
  return null;
}

function dlClip(v: unknown, max: number): string | undefined {
  const t = typeof v === "string" ? v.trim() : "";
  return t.slice(0, max) || undefined;
}

/** Normalisasi respons api-faa → objek dl ringkas. */
function buildDl(platform: string, result: Record<string, unknown>): DlCard | null {
  if (!result || typeof result !== "object") return null;
  const dl: Record<string, unknown> = { platform };

  if (platform === "tiktok") {
    const isSlide = result.type === "image" || Array.isArray(result.data);
    const urls = (strOrArr: unknown): string[] =>
      Array.isArray(strOrArr)
        ? (strOrArr as unknown[]).filter((x): x is string => typeof x === "string" && /^https:/.test(x))
        : typeof strOrArr === "string" && /^https:/.test(strOrArr)
          ? [strOrArr]
          : [];
    dl.id = dlClip(result.id, 32);
    dl.title = dlClip(result.title, 120);
    dl.cover = /^https:/.test(String(result.cover || "")) ? result.cover : undefined;
    const author = result.author as Record<string, unknown> | undefined;
    if (author) {
      dl.author = dlClip(author.nickname || author.username, 60);
    }
    const musicInfo = result.music_info as Record<string, unknown> | undefined;
    const music = musicInfo && String(musicInfo.url || "");
    if (/^https:/.test(music || "")) {
      dl.music = music;
      dl.music_title = dlClip(musicInfo!.title, 80);
    }
    if (isSlide) {
      dl.type = "image";
      dl.images = urls(result.data).slice(0, 12);
    } else {
      dl.type = "video";
      const alts = result.alternatives as Record<string, unknown> | undefined;
      dl.video = dlClip(
        result.data ||
          (alts && (alts.selected || alts.hd || alts.sd || alts.wm)),
        1500
      );
      if (!/^https:/.test(String(dl.video || ""))) return null;
    }
  } else {
    // Instagram: result.url = daftar link media (rapidcdn, sudah dl=1)
    const urlList = Array.isArray(result.url)
      ? (result.url as unknown[]).filter(
          (x) => typeof x === "string" && /^https:/.test(x)
        ) as string[]
      : [];
    if (!urlList.length) return null;
    const meta = (result.metadata || {}) as Record<string, unknown>;
    dl.type = meta.isVideo ? "video" : "image";
    dl.title = dlClip(meta.caption, 120);
    if (dl.type === "video") dl.video = urlList[0];
    else dl.images = urlList.slice(0, 12);
  }
  return dl as unknown as DlCard;
}

/** Cek magic bytes → { mime, ext } | null. */
function sniffImage(buf: Buffer): { mime: string; ext: string } | null {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { mime: "image/png", ext: "png" };
  }
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  if (
    buf.length > 12 &&
    buf.subarray(0, 4).toString("latin1") === "RIFF" &&
    buf.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return { mime: "image/webp", ext: "webp" };
  }
  if (buf.length > 6 && buf.subarray(0, 3).toString("latin1") === "GIF") {
    return { mime: "image/gif", ext: "gif" };
  }
  return null;
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Upsert entri index percakapan. */
async function touchIndex(uid: string, entry: ConversationItem): Promise<void> {
  await updateJson<ConversationItem[]>(`chats/${uid}/_index.json`, "conversation index", (current) => {
    const items = Array.isArray(current) ? current : [];
    const i = items.findIndex((c) => c.conversation_id === entry.conversation_id);
    if (i >= 0) items[i] = entry;
    else items.unshift(entry);
    return items;
  });
}

// ---------------- HANDLER ----------------

export async function POST(req: Request) {
  // Wajib login → riwayat per akun, tidak pernah tercampur
  const session = await getSession(req.headers);
  if (!session) return json({ error: "Sesi berakhir. Silakan login kembali.", code: "SESSION_INVALID" }, 401);
  const uid = session.user_id;

  // Gerbang maintenance + akun dibekukan + feature flag chat (server-side).
  const maintGate = await maintenanceBlockResponse();
  if (maintGate) return maintGate;
  if (await isUserSuspended(uid)) {
    return json({ error: "Akun kamu sedang dibekukan admin.", code: "SUSPENDED" }, 403);
  }
  const flags = await getFlags();
  if (!flags.chat) {
    return json({ error: "Chat sedang dinonaktifkan sementara oleh admin.", code: "FEATURE_DISABLED" }, 503);
  }

  if (!originOk(req)) return forbidden();

  // Chat TIDAK dibatasi rate limit (permintaan owner) — pemakaian normal
  // dibatasi alami oleh durasi respons AI. Origin check tetap jalan.

  const body = await readBody(req);
  const greeting = body.greeting === true; // mode: karakter menyapa duluan
  const message = sanitize(body.message, LIMITS.messageMaxLen);

  // Gambar (opsional): dataURL hasil kompresi klien.
  // - image: ≤1024px (dikirim ke AI vision)
  // - thumb: ≤360px (disimpan ke percakapan biar JSON tetap ringan)
  let imageBuffer: Buffer | null = null;
  let imageDataUrl: string | null = null;
  let imageName = "";
  let imageThumb: string | null = null;
  let imgMatch: RegExpMatchArray | null = null;
  if (typeof body.image === "string") {
    imgMatch = body.image.match(/^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
  }
  if (imgMatch) {
    imageBuffer = Buffer.from(imgMatch[2], "base64");
    if (imageBuffer.length > 4_000_000) {
      return json({ error: "Gambar terlalu besar (maks ~4MB). Coba yang lebih kecil." }, 413);
    }
    imageDataUrl = body.image as string;
    imageName = "image." + (imgMatch[1].split("/")[1] === "jpeg" ? "jpg" : imgMatch[1].split("/")[1]);
    imageThumb =
      typeof body.thumb === "string" && (body.thumb as string).startsWith("data:image/")
        ? (body.thumb as string)
        : null;
  } else if (typeof body.image === "string" && (body.image as string).length > 0) {
    return json({ error: "Format gambar tidak didukung. Gunakan PNG, JPG, WebP, atau GIF." }, 400);
  }

  // Video (opsional): URL hasil upload via /api/vupload + frame untuk
  // AI vision. URL hanya boleh dari uguu (hosting milik flow ini) —
  // server tidak pernah fetch URL asing dari sini (anti SSRF).
  let videoInfo: { url: string; name: string; size: number } | null = null;
  if (body.video && typeof body.video === "object") {
    const v = body.video as { url?: unknown; name?: unknown; size?: unknown };
    const url = String(v.url || "");
    if (!UPLOAD_HOST_RE.test(url)) {
      return json({ error: "URL video tidak valid. Upload ulang videonya ya." }, 400);
    }
    videoInfo = {
      url,
      name: sanitize(v.name, 80) || "video.mp4",
      size: Math.max(0, Number(v.size) || 0),
    };
  }

  if (videoInfo && !flags.video) {
    return json({ error: "Fitur video sedang dinonaktifkan sementara oleh admin." }, 503);
  }

  // Frame video (opsional): maksimal 6 gambar JPEG hasil ekstraksi
  // di browser — ini "mata" AI untuk video (upload video langsung ke
  // Gemini butuh akun login, jadi kirim frame saja).
  const frameBuffers: Buffer[] = [];
  if (Array.isArray(body.frames)) {
    for (const f of (body.frames as unknown[]).slice(0, 6)) {
      if (frameBuffers.length >= 6) break;
      if (typeof f !== "string") continue;
      const m = f.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
      if (!m) continue;
      const buf = Buffer.from(m[1], "base64");
      if (buf.length > 1_500_000) continue; // per frame maks ~1.5MB
      frameBuffers.push(buf);
    }
  }

  // Pesan boleh kosong kalau ada gambar / video
  if (!message && !greeting && !imageBuffer && !videoInfo) {
    return json({ error: "Pesan tidak valid" }, 400);
  }

  // Muat / buat percakapan milik user ini
  const convId = String(body.conversation_id || "");
  const convPath = `chats/${uid}/${convId}.json`;
  const file = /^[a-f0-9-]{8,36}$/.test(convId) ? await readJson<Conversation>(convPath) : null;
  const conv: Conversation & { geminiSessionId?: string | null } = file
    ? { ...file.data, messages: Array.isArray(file.data.messages) ? file.data.messages : [] }
    : {
        conversation_id: crypto.randomUUID(),
        user_id: uid,
        title: "Chat baru",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        geminiSessionId: null,
        messages: [],
      };

  if (conv.messages.length > LIMITS.maxMessages) {
    conv.messages = conv.messages.slice(-LIMITS.maxMessages);
  }

  // Customization bot milik user ini (terisolasi per akun)
  const botFile = await readJson<BotConfig>(`bots/${uid}.json`);
  const bot: BotConfig = { ...DEFAULT_BOT, ...(botFile?.data || {}) };
  const instruction = buildInstruction(bot);

  async function askProviders(input: ChatInput, instruction: string) {
    try {
      const out = await chatGemini(input, instruction);
      return { reply: out.text, provider: "gemini", geminiSid: out.geminiSessionId };
    } catch (err) {
      console.error("[chat] gemini:", (err as Error).message);
      return { reply: null, provider: null, geminiSid: null };
    }
  }

  const now = new Date().toISOString();

  // ---------------- MODE GREETING (sapaan pertama karakter) ----------------
  if (greeting) {
    // percakapan sudah berjalan → jangan sapa lagi
    if (conv.messages.length > 0) {
      return json({ text: null, already: true, conversation_id: conv.conversation_id });
    }

    // Sapaan custom dari konfigurasi karakter → pakai apa adanya
    let greet = (bot.greeting || "").trim();
    let provider = "character-config";

    if (!greet) {
      const input: ChatInput = {
        message: "[pengguna baru membuka chat dan belum menulis apa pun. kirim sapaan pertamamu sekarang.]",
        geminiSessionId: null,
        messages: [],
        imageBuffer: null,
        imageName: null,
      };
      const out = await askProviders(input, greetingInstruction(bot));
      greet = (out.reply || "").trim();
      provider = out.provider || "fallback";

      // Semua provider gagal → template per sifat karakter
      if (!greet) {
        const traits = Array.isArray(bot.traits) ? bot.traits : [];
        const key = traits.find((t) => GREETING_FALLBACKS[t]) || "default";
        greet = GREETING_FALLBACKS[key][0];
        provider = "template";
      }
    }

    const greetId = crypto.randomUUID();
    conv.messages.push({
      message_id: greetId,
      role: "assistant",
      content: greet,
      timestamp: now,
    });
    if (conv.title === "Chat baru") conv.title = greet.slice(0, 48);
    conv.updated_at = now;

    await Promise.all([
      putJson(`chats/${uid}/${conv.conversation_id}.json`, conv, "greeting append"),
      touchIndex(uid, {
        conversation_id: conv.conversation_id,
        title: conv.title,
        updated_at: conv.updated_at,
      }),
    ]);

    return json({
      text: greet,
      message_id: greetId,
      conversation_id: conv.conversation_id,
      title: conv.title,
      provider,
      greeting: true,
      bot_name: bot.bot_name,
    });
  }

  // ---------------- MODE THUMB (thumbnail hasil edit foto) ----------------
  if (body.action === "thumb") {
    if (!file) return json({ error: "Percakapan tidak ditemukan" }, 404);

    const mid = String(body.message_id || "");
    const thumb = typeof body.thumb === "string" ? (body.thumb as string) : "";
    const target = conv.messages.find(
      (m) =>
        m &&
        m.message_id === mid &&
        m.role === "assistant" &&
        typeof m.image_url === "string"
    );
    if (!target) return json({ error: "Pesan tidak ditemukan" }, 404);

    if (!/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(thumb) || thumb.length > 400_000) {
      return json({ error: "Thumbnail tidak valid" }, 400);
    }
    target.image = thumb;
    await putJson(`chats/${uid}/${conv.conversation_id}.json`, conv, "edit result thumb");
    return json({ ok: true });
  }

  // ---------------- MODE REGENERATE / EDIT PESAN ----------------
  if (body.action === "regenerate" || body.action === "edit") {
    if (!file) return json({ error: "Percakapan tidak ditemukan" }, 404);

    const editing = body.action === "edit";

    if (editing) {
      const mid = String(body.message_id || "");
      const newText = sanitize(body.text, LIMITS.messageMaxLen);
      const idx = conv.messages.findIndex(
        (m) => m && m.message_id === mid && m.role === "user"
      );
      if (idx < 0) return json({ error: "Pesan tidak ditemukan" }, 404);
      if (!newText && !conv.messages[idx].image) {
        return json({ error: "Pesan tidak valid" }, 400);
      }
      // Update isi pesan + truncate percakapan SETELAH titik ini
      conv.messages[idx].content = newText;
      conv.messages = conv.messages.slice(0, idx + 1);
    } else {
      // Buang semua assistant message di ujung; sisakan user terakhir
      while (conv.messages.length && conv.messages[conv.messages.length - 1].role === "assistant") {
        conv.messages.pop();
      }
      if (!conv.messages.length || conv.messages[conv.messages.length - 1].role !== "user") {
        return json({ error: "Tidak ada pesan untuk dijawab ulang" }, 400);
      }
    }

    const lastUser = conv.messages[conv.messages.length - 1];
    const contextBefore = conv.messages.slice(0, -1);

    // Thread Gemini baru: jawaban lama tidak terkirim ulang (no duplikat),
    // karakter tetap "ingat" via recap.
    const recap = buildRecap(contextBefore);
    const userText = String(lastUser.content || "").trim() || "(aku baru kirim gambar ke kamu)";
    const regenMessage = recap ? recap + "\n\n" + userText : userText;

    // Gambar tersimpan (thumbnail) → kirim ulang agar vision tetap jalan
    let regImgBuffer: Buffer | null = null;
    let regImgName: string | null = null;
    const gmatch =
      typeof lastUser.image === "string"
        ? lastUser.image.match(/^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+\/=]+)$/)
        : null;
    if (gmatch) {
      regImgBuffer = Buffer.from(gmatch[2], "base64");
      regImgName =
        "image." + (gmatch[1].split("/")[1] === "jpeg" ? "jpg" : gmatch[1].split("/")[1]);
    }

    const regOut = await askProviders(
      {
        message: regenMessage,
        geminiSessionId: null,
        messages: contextBefore,
        imageBuffer: regImgBuffer,
        imageName: regImgBuffer ? regImgName : null,
      },
      instruction
    );
    if (!regOut.reply) {
      return json({ error: "Koneksi sedang bermasalah. Coba lagi nanti ya." }, 502);
    }

    const assistantId = crypto.randomUUID();
    conv.messages.push({
      message_id: assistantId,
      role: "assistant",
      content: regOut.reply,
      timestamp: new Date().toISOString(),
    });
    conv.updated_at = new Date().toISOString();
    if (regOut.geminiSid) conv.geminiSessionId = regOut.geminiSid;

    await Promise.all([
      putJson(`chats/${uid}/${conv.conversation_id}.json`, conv, "message regenerate/edit"),
      touchIndex(uid, {
        conversation_id: conv.conversation_id,
        title: conv.title,
        updated_at: conv.updated_at,
      }),
    ]);

    return json({
      text: regOut.reply,
      assistant_message_id: assistantId,
      user_message_id: editing ? lastUser.message_id : undefined,
      conversation_id: conv.conversation_id,
      title: conv.title,
      provider: regOut.provider,
      bot_name: bot.bot_name,
    });
  }

  // ---------------- MODE HD FOTO (upscale, server-side) ----------------
  // Gambar terlampir + kata "hdkan"/"jadiin hd" → upscale lewat API faa
  // hdv4 (sinkron ±7 detik, aman di server). Alur: host input di
  // tempimg → hdv4 → unduh hasil → rehost tempimg (TTL 3 hari).
  if (imageBuffer && message && HD_TRIGGER_RE.test(message)) {
    if (!flags.hd) return json({ error: "Fitur HD sedang dinonaktifkan sementara oleh admin." }, 503);
    if (!allowUser("chathd", uid, req, 4, 60_000)) {
      return json({ error: "Sabar, foto sebelumnya masih diproses. Coba lagi sebentar." }, 429);
    }

    const host = String(req.headers.get("host") || "").replace(/[^a-zA-Z0-9.\-]/g, "");
    if (!host) {
      return json({ error: "Host tidak diketahui. Coba lagi." }, 500);
    }

    // Host gambar input sebagai URL publik (hdv4 butuh URL)
    const tempId = crypto.randomUUID();
    await putJson(
      `tempimg/${tempId}.json`,
      { b64: imageBuffer.toString("base64"), mime: imgMatch![1] },
      "temp image"
    );
    await expireJson(`tempimg/${tempId}.json`, LIMITS.tempInputTtl);
    const publicUrl = `https://${host}/api/tempimg?id=${tempId}`;

    // Upscale lalu unduh hasilnya
    let resultBytes: Buffer;
    let resultMime: string;
    try {
      const upscaledUrl = await upscalePhoto(publicUrl);
      const out = await fetchUpscaledBytes(upscaledUrl, LIMITS.editResultMax);
      resultBytes = out.buffer;
      resultMime = out.mime;
    } catch (err) {
      const code = err instanceof HdPhotoError ? err.code : "UPSTREAM";
      console.error("[chat] hd foto gagal (" + code + "):", (err as Error).message);
      return json({ error: "Fotonya gak bisa diproses jadi HD. Coba lagi ya." }, 502);
    }
    const sniff = sniffImage(resultBytes) || { mime: resultMime, ext: resultMime.includes("png") ? "png" : "jpg" };

    // Rehost hasil (TTL unduh 3 hari) → URL publik milik kita
    const resultId = crypto.randomUUID();
    await putJson(
      `tempimg/${resultId}.json`,
      { b64: resultBytes.toString("base64"), mime: sniff.mime },
      "hd photo result"
    );
    await expireJson(`tempimg/${resultId}.json`, LIMITS.tempResultTtl);
    const resultUrl = `https://${host}/api/tempimg?id=${resultId}`;
    const imageSaveName = `aomi-hd-${resultId.slice(0, 8)}.${sniff.ext}`;
    const expiresAt = new Date(Date.now() + LIMITS.tempResultTtl * 1000).toISOString();

    const replyText =
      "ini dia foto HD-nya~ resolusinya udah dinaikin, bisa diunduh di bawah ya.";
    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    conv.messages.push(
      {
        message_id: userMessageId,
        role: "user",
        content: message,
        image: imageThumb || imageDataUrl,
        timestamp: now,
      },
      {
        message_id: assistantMessageId,
        role: "assistant",
        content: replyText,
        image_url: resultUrl,
        image_name: imageSaveName,
        image_mime: sniff.mime,
        expires_at: expiresAt,
        timestamp: now,
      }
    );
    if (conv.title === "Chat baru") conv.title = message.slice(0, 48) || "Foto HD";
    conv.updated_at = now;

    await Promise.all([
      putJson(`chats/${uid}/${conv.conversation_id}.json`, conv, "hd photo append"),
      touchIndex(uid, {
        conversation_id: conv.conversation_id,
        title: conv.title,
        updated_at: conv.updated_at,
      }),
    ]);

    return json({
      text: replyText,
      user_message_id: userMessageId,
      assistant_message_id: assistantMessageId,
      conversation_id: conv.conversation_id,
      title: conv.title,
      provider: "faa-hdphoto",
      bot_name: bot.bot_name,
      image_url: resultUrl,
      image_name: imageSaveName,
      expires_at: expiresAt,
    });
  }

  // ---------------- MODE EDIT FOTO (tahap START) ----------------
  // Simpan pesan user + host gambar sebagai URL temp, balas CEPAT dengan
  // job info. Browser yang menembak API edit eksternal.
  if (imageBuffer && message && EDIT_TRIGGER_RE.test(message)) {
    if (!flags["image-edit"]) return json({ error: "Fitur edit foto sedang dinonaktifkan sementara oleh admin." }, 503);
    const tempId = crypto.randomUUID();
    await putJson(
      `tempimg/${tempId}.json`,
      { b64: imageBuffer.toString("base64"), mime: imgMatch![1] },
      "temp image"
    );
    await expireJson(`tempimg/${tempId}.json`, LIMITS.tempInputTtl);

    const host = String(req.headers.get("host") || "").replace(/[^a-zA-Z0-9.\-]/g, "");
    if (!host) {
      return json({ error: "Host tidak diketahui. Coba lagi." }, 500);
    }
    const publicUrl = `https://${host}/api/tempimg?id=${tempId}`;

    const userMessageId = crypto.randomUUID();
    conv.messages.push({
      message_id: userMessageId,
      role: "user",
      content: message,
      image: imageThumb || imageDataUrl,
      timestamp: now,
    });
    if (conv.title === "Chat baru") conv.title = message.slice(0, 48) || "Edit foto";
    conv.updated_at = now;

    await Promise.all([
      putJson(`chats/${uid}/${conv.conversation_id}.json`, conv, "photo edit start"),
      touchIndex(uid, {
        conversation_id: conv.conversation_id,
        title: conv.title,
        updated_at: conv.updated_at,
      }),
    ]);

    // Balasan cepat: browser lanjut menembak API edit sendiri (CORS terbuka),
    // lalu hasilnya dikirim balik lewat action 'edit-save'.
    return json({
      edit_job: { input_url: publicUrl, prompt: message },
      user_message_id: userMessageId,
      conversation_id: conv.conversation_id,
      title: conv.title,
      bot_name: bot.bot_name,
    });
  }

  // ---------------- EDIT SAVE: browser kirim hasil edit (dataURL) ----------------
  if (body.action === "edit-save" && imageBuffer) {
    // imageBuffer di sini = gambar HASIL edit dari API eksternal
    if (imageBuffer.length > LIMITS.editResultMax) {
      return json({ error: "Hasil edit terlalu besar." }, 413);
    }
    const sniff = sniffImage(imageBuffer);
    if (!sniff) {
      return json({ error: "Hasil edit tidak bisa dibaca sebagai gambar. Coba lagi ya." }, 502);
    }

    const host = String(req.headers.get("host") || "").replace(/[^a-zA-Z0-9.\-]/g, "");
    if (!host) {
      return json({ error: "Host tidak diketahui. Coba lagi." }, 500);
    }

    // Simpan hasil sebagai gambar temp (TTL unduh 3 hari) → URL publik
    const resultId = crypto.randomUUID();
    await putJson(
      `tempimg/${resultId}.json`,
      { b64: imageBuffer.toString("base64"), mime: sniff.mime },
      "edit result"
    );
    await expireJson(`tempimg/${resultId}.json`, LIMITS.tempResultTtl);
    const resultUrl = `https://${host}/api/tempimg?id=${resultId}`;
    const imageSaveName = `aomi-edit-${resultId.slice(0, 8)}.${sniff.ext}`;
    const expiresAt = new Date(Date.now() + LIMITS.tempResultTtl * 1000).toISOString();

    const replyText =
      "selesai~ ini dia hasilnya. kalau masih kurang pas, kirim fotonya lagi bareng instruksinya ya.";
    const assistantMessageId = crypto.randomUUID();
    conv.messages.push({
      message_id: assistantMessageId,
      role: "assistant",
      content: replyText,
      image_url: resultUrl,
      image_name: imageSaveName,
      image_mime: sniff.mime,
      expires_at: expiresAt,
      edit: true,
      timestamp: now,
    });
    conv.updated_at = now;

    await Promise.all([
      putJson(`chats/${uid}/${conv.conversation_id}.json`, conv, "photo edit append"),
      touchIndex(uid, {
        conversation_id: conv.conversation_id,
        title: conv.title,
        updated_at: conv.updated_at,
      }),
    ]);

    return json({
      text: replyText,
      assistant_message_id: assistantMessageId,
      conversation_id: conv.conversation_id,
      title: conv.title,
      provider: "faa-edit",
      bot_name: bot.bot_name,
      image_url: resultUrl,
      image_name: imageSaveName,
      expires_at: expiresAt,
      edit: true,
    });
  }

  // ---------------- IMGGEN SAVE: browser kirim hasil generate (dataURL) ----------------
  // Sama seperti edit-save: browser menembak API faa sendiri (CORS
  // terbuka, +/-30-60s) lalu hasilnya disimpan di sini sebagai gambar
  // temp dengan masa unduh 3 hari.
  if (body.action === "imggen-save" && imageBuffer) {
    if (imageBuffer.length > LIMITS.editResultMax) {
      return json({ error: "Hasil generate terlalu besar." }, 413);
    }
    const sniff = sniffImage(imageBuffer);
    if (!sniff) {
      return json({ error: "Hasil generate tidak bisa dibaca sebagai gambar. Coba lagi ya." }, 502);
    }

    const host = String(req.headers.get("host") || "").replace(/[^a-zA-Z0-9.\-]/g, "");
    if (!host) {
      return json({ error: "Host tidak diketahui. Coba lagi." }, 500);
    }

    const resultId = crypto.randomUUID();
    await putJson(
      `tempimg/${resultId}.json`,
      { b64: imageBuffer.toString("base64"), mime: sniff.mime },
      "imggen result"
    );
    await expireJson(`tempimg/${resultId}.json`, LIMITS.tempResultTtl);
    const resultUrl = `https://${host}/api/tempimg?id=${resultId}`;
    const imageSaveName = `aomi-gambar-${resultId.slice(0, 8)}.${sniff.ext}`;
    const expiresAt = new Date(Date.now() + LIMITS.tempResultTtl * 1000).toISOString();

    const replyText =
      "ini dia gambarnya~ bisa diunduh di bawah. kalau mau versi lain atau detailnya diubah, bilang aja prompt baru ya.";
    const assistantMessageId = crypto.randomUUID();
    conv.messages.push({
      message_id: assistantMessageId,
      role: "assistant",
      content: replyText,
      image_url: resultUrl,
      image_name: imageSaveName,
      image_mime: sniff.mime,
      expires_at: expiresAt,
      timestamp: now,
    });
    conv.updated_at = now;

    await Promise.all([
      putJson(`chats/${uid}/${conv.conversation_id}.json`, conv, "imggen append"),
      touchIndex(uid, {
        conversation_id: conv.conversation_id,
        title: conv.title,
        updated_at: conv.updated_at,
      }),
    ]);

    return json({
      text: replyText,
      assistant_message_id: assistantMessageId,
      conversation_id: conv.conversation_id,
      title: conv.title,
      provider: "faa-imggen",
      bot_name: bot.bot_name,
      image_url: resultUrl,
      image_name: imageSaveName,
      expires_at: expiresAt,
    });
  }

  // ---------------- EDIT FAIL: browser laporkan edit gagal ----------------
  if ((body.action === "edit-fail" || body.action === "imggen-fail") && message) {
    const assistantMessageId = crypto.randomUUID();
    conv.messages.push({
      message_id: assistantMessageId,
      role: "assistant",
      content: message,
      timestamp: now,
    });
    conv.updated_at = now;
    await Promise.all([
      putJson(`chats/${uid}/${conv.conversation_id}.json`, conv, "photo edit fail"),
      touchIndex(uid, {
        conversation_id: conv.conversation_id,
        title: conv.title,
        updated_at: conv.updated_at,
      }),
    ]);
    return json({ ok: true });
  }

  // ---------------- MODE GENERATE GAMBAR (tahap START) ----------------
  // "buatkan gambar X" / "bikin gambar X" / "gambarin X" -> simpan
  // pesan user, balas CEPAT dengan job info. Browser menembak API
  // faa text2img sendiri (generate +/-30-60s, kepanjangan buat server).
  if (!imageBuffer && message) {
    const genPrompt = matchImageGenRequest(message);
    if (genPrompt) {
      if (!flags.imggen) return json({ error: "Fitur generate gambar sedang dinonaktifkan sementara oleh admin." }, 503);
      if (!allowUser("chatimggen", uid, req, 6, 60_000)) {
        return json({ error: "Sabar, gambar sebelumnya masih diproses. Coba lagi sebentar." }, 429);
      }

      const userMessageId = crypto.randomUUID();
      conv.messages.push({
        message_id: userMessageId,
        role: "user",
        content: message,
        timestamp: now,
      });
      if (conv.title === "Chat baru") conv.title = genPrompt.slice(0, 48);
      conv.updated_at = now;

      await Promise.all([
        putJson(`chats/${uid}/${conv.conversation_id}.json`, conv, "imggen start"),
        touchIndex(uid, {
          conversation_id: conv.conversation_id,
          title: conv.title,
          updated_at: conv.updated_at,
        }),
      ]);

      return json({
        imggen_job: { prompt: genPrompt },
        user_message_id: userMessageId,
        conversation_id: conv.conversation_id,
        title: conv.title,
        bot_name: bot.bot_name,
      });
    }
  }

  // ---------------- MODE HD VIDEO UPLOAD (hdkan video yang diupload) ----------------
  // Pengguna upload video lewat composer lalu bilang "hdkan" (tanpa
  // link — URL sudah ada dari /api/vupload). Alur kartu sama persis
  // dengan mode HD berbasis link.
  if (videoInfo && message && HD_TRIGGER_RE.test(message)) {
    if (!flags.hd) return json({ error: "Fitur HD sedang dinonaktifkan sementara oleh admin." }, 503);
    if (!allowUser("chathd", uid, req, 4, 60_000)) {
      return json({ error: "Sabar, video sebelumnya masih diproses. Coba lagi sebentar." }, 429);
    }

    let job: { job_id: string };
    try {
      job = await submitHdJob(videoInfo.url);
    } catch (err) {
      const code = err instanceof HdError ? err.code : "UPSTREAM";
      console.error("[chat] hd upload gagal (" + code + "):", (err as Error).message);
      return json({ error: "Videonya gak bisa diproses jadi HD. Coba lagi ya." }, 502);
    }

    const card: HdCard = {
      job_id: job.job_id,
      state: "pending",
      source_url: videoInfo.url,
      quality: "HD",
    };
    const replyText =
      "oke, videonya lagi ditingkatin ke HD nih~ prosesnya biasanya beberapa puluh detik, kartunya bakal update sendiri pas hasilnya siap.";
    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    conv.messages.push(
      {
        message_id: userMessageId,
        role: "user",
        content: message,
        video: { url: videoInfo.url, name: videoInfo.name },
        timestamp: now,
      },
      { message_id: assistantMessageId, role: "assistant", content: replyText, hd: card, timestamp: now }
    );
    if (conv.title === "Chat baru") conv.title = "Video HD";
    conv.updated_at = now;

    await Promise.all([
      putJson(`chats/${uid}/${conv.conversation_id}.json`, conv, "hd append"),
      touchIndex(uid, {
        conversation_id: conv.conversation_id,
        title: conv.title,
        updated_at: conv.updated_at,
      }),
    ]);

    return json({
      text: replyText,
      user_message_id: userMessageId,
      assistant_message_id: assistantMessageId,
      conversation_id: conv.conversation_id,
      title: conv.title,
      provider: "faa-hd",
      bot_name: bot.bot_name,
      hd: card,
      video: { url: videoInfo.url, name: videoInfo.name },
    });
  }

  // ---------------- MODE HD VIDEO (submit job) ----------------
  // "hdkan <link video>" -> submit job ke API faa, simpan kartu HD
  // (state pending) di pesan assistant, balas cepat. Client polling
  // /api/hd?action=poll sampai "done" -> tombol unduh muncul.
  if (!imageBuffer && !videoInfo && message) {
    const hdUrl = matchHdRequest(message);
    if (hdUrl) {
      if (!flags.hd) return json({ error: "Fitur HD sedang dinonaktifkan sementara oleh admin." }, 503);
      if (!allowUser("chathd", uid, req, 4, 60_000)) {
        return json({ error: "Sabar, video sebelumnya masih diproses. Coba lagi sebentar." }, 429);
      }

      let job: { job_id: string };
      try {
        job = await submitHdJob(hdUrl);
      } catch (err) {
        const code = err instanceof HdError ? err.code : "UPSTREAM";
        console.error("[chat] hd gagal (" + code + "):", (err as Error).message);
        return json({ error: "Videonya gak bisa diproses jadi HD. Cek linknya terus coba lagi ya." }, 502);
      }

      const card: HdCard = {
        job_id: job.job_id,
        state: "pending",
        source_url: hdUrl,
        quality: "HD",
      };
      const replyText =
        "oke, videonya lagi ditingkatin ke HD nih~ prosesnya biasanya beberapa puluh detik, kartunya bakal update sendiri pas hasilnya siap.";
      const userMessageId = crypto.randomUUID();
      const assistantMessageId = crypto.randomUUID();
      conv.messages.push(
        { message_id: userMessageId, role: "user", content: message, timestamp: now },
        { message_id: assistantMessageId, role: "assistant", content: replyText, hd: card, timestamp: now }
      );
      if (conv.title === "Chat baru") conv.title = "Video HD";
      conv.updated_at = now;

      await Promise.all([
        putJson(`chats/${uid}/${conv.conversation_id}.json`, conv, "hd append"),
        touchIndex(uid, {
          conversation_id: conv.conversation_id,
          title: conv.title,
          updated_at: conv.updated_at,
        }),
      ]);

      return json({
        text: replyText,
        user_message_id: userMessageId,
        assistant_message_id: assistantMessageId,
        conversation_id: conv.conversation_id,
        title: conv.title,
        provider: "faa-hd",
        bot_name: bot.bot_name,
        hd: card,
      });
    }
  }

  // ---------------- MODE MUSIK (putar lagu) ----------------
  // "tolong putarkan lagu X" / "playkan X" / "putar <link YT>" →
  // cari lagu (YouTube), ambil audio (savetube) + lirik (LRCLIB),
  // simpan kartu lagu di pesan assistant. Player ada di client.
  if (!imageBuffer && message) {
    const musicQuery = matchMusicRequest(message);
    if (musicQuery) {
      if (!flags.music) return json({ error: "Fitur musik sedang dinonaktifkan sementara oleh admin." }, 503);
      if (!allowUser("chatmusic", uid, req, 8, 60_000)) {
        return json({ error: "Sabar, lagu sebelumnya masih diproses. Coba lagi sebentar." }, 429);
      }

      let card;
      try {
        card = await resolveMusicCard(musicQuery);
      } catch (err) {
        const code = err instanceof MusicError ? err.code : "UPSTREAM";
        console.error("[chat] musik gagal (" + code + "):", (err as Error).message);
        if (code === "NO_CONFIG") {
          return json({ error: "Fitur musik belum dikonfigurasi di server." }, 503);
        }
        return json({ error: "Hmm, lagunya gak ketemu / gagal diambil. Coba judul lain ya." }, 502);
      }

      const replyText =
        "sini kuputarke lagunya~ klik karta lagunya kalau mau pause/lanjut, atau buka player-nya. ada tombol unduhnya juga di player. \uD83C\uDFB7";
      const userMessageId = crypto.randomUUID();
      const assistantMessageId = crypto.randomUUID();
      conv.messages.push(
        { message_id: userMessageId, role: "user", content: message, timestamp: now },
        { message_id: assistantMessageId, role: "assistant", content: replyText, music: card, timestamp: now }
      );
      if (conv.title === "Chat baru") {
        conv.title = card.title.slice(0, 48);
      }
      conv.updated_at = now;

      await Promise.all([
        putJson(`chats/${uid}/${conv.conversation_id}.json`, conv, "music append"),
        touchIndex(uid, {
          conversation_id: conv.conversation_id,
          title: conv.title,
          updated_at: conv.updated_at,
        }),
      ]);

      return json({
        text: replyText,
        user_message_id: userMessageId,
        assistant_message_id: assistantMessageId,
        conversation_id: conv.conversation_id,
        title: conv.title,
        provider: "aomi-music",
        bot_name: bot.bot_name,
        music: card,
      });
    }
  }

  // ---------------- MODE DOWNLOADER (TikTok / Instagram) ----------------
  if (!imageBuffer && message) {
    const target = matchDownloadTarget(message);
    if (target) {
      const endpoint =
        (target.platform === "tiktok" ? DL_TIKTOK_API : DL_IG_API) +
        "?url=" +
        encodeURIComponent(target.url);

      let dlRes: Response;
      try {
        dlRes = await fetchWithTimeout(endpoint, LIMITS.downloadTimeout);
      } catch {
        return json({ error: "Layanan unduhan sedang tidak bisa dihubungi. Coba lagi ya." }, 504);
      }
      let dlJson: Record<string, unknown> | null = null;
      try {
        dlJson = (await dlRes.json()) as Record<string, unknown>;
      } catch {
        /* bukan JSON */
      }
      const dl =
        dlRes.ok && dlJson && dlJson.status
          ? buildDl(target.platform, (dlJson.result || {}) as Record<string, unknown>)
          : null;

      if (!dl) {
        console.error(
          "[chat] downloader gagal",
          dlRes.status,
          (dlJson && dlJson.result && JSON.stringify(dlJson.result).slice(0, 200)) || ""
        );
        return json(
          { error: "Gagal mengunduh linknya. Pastikan linknya publik dan coba lagi ya." },
          502
        );
      }

      const platformLabel = dl.platform === "tiktok" ? "TikTok" : "Instagram";
      let replyText: string;
      if (dl.type === "video") {
        replyText = `selesai~ ini dia videonya. tinggal klik tombol unduh di bawah ya${dl.music ? " (ada audionya juga)" : ""}.`;
      } else {
        replyText = `selesai~ ini dia ${dl.images && dl.images.length > 1 ? dl.images.length + " fotonya" : "fotonya"}. tinggal klik gambar atau tombol unduhnya ya${dl.music ? " (ada audionya juga)" : ""}.`;
      }

      const userMessageId = crypto.randomUUID();
      const assistantMessageId = crypto.randomUUID();
      conv.messages.push(
        { message_id: userMessageId, role: "user", content: message, timestamp: now },
        { message_id: assistantMessageId, role: "assistant", content: replyText, dl, timestamp: now }
      );
      if (conv.title === "Chat baru") {
        conv.title = (dl.title || "Unduhan " + platformLabel).slice(0, 48);
      }
      conv.updated_at = now;

      await Promise.all([
        putJson(`chats/${uid}/${conv.conversation_id}.json`, conv, "download append"),
        touchIndex(uid, {
          conversation_id: conv.conversation_id,
          title: conv.title,
          updated_at: conv.updated_at,
        }),
      ]);

      return json({
        text: replyText,
        user_message_id: userMessageId,
        assistant_message_id: assistantMessageId,
        conversation_id: conv.conversation_id,
        title: conv.title,
        provider: "faa-dl",
        bot_name: bot.bot_name,
        dl,
      });
    }
  }

  // ---------------- MODE CHAT NORMAL ----------------
  const input: ChatInput = {
    message: message || (videoInfo ? "(aku baru kirim video ke kamu)" : "(aku baru kirim gambar ke kamu)"),
    geminiSessionId: conv.geminiSessionId || null,
    messages: conv.messages,
    imageBuffer,
    imageName: imageBuffer ? imageName : null,
    imageDataUrl: imageBuffer ? imageDataUrl : null,
    frameBuffers,
    videoInfo: videoInfo ? { name: videoInfo.name, size: videoInfo.size } : null,
  };
  const { reply, provider, geminiSid: newGeminiSid } = await askProviders(input, instruction);

  if (!reply) {
    return json({ error: "Koneksi sedang bermasalah. Coba lagi nanti ya." }, 502);
  }

  // Simpan pesan ke percakapan user (gambar disimpan sebagai thumbnail)
  const userMessageId = crypto.randomUUID();
  const assistantMessageId = crypto.randomUUID();
  conv.messages.push(
    {
      message_id: userMessageId,
      role: "user",
      content: message,
      image: imageBuffer ? imageThumb || imageDataUrl || undefined : undefined,
      video: videoInfo ? { url: videoInfo.url, name: videoInfo.name } : undefined,
      timestamp: now,
    },
    { message_id: assistantMessageId, role: "assistant", content: reply, timestamp: now }
  );
  if (conv.title === "Chat baru") {
    conv.title = message.slice(0, 48) || "Gambar";
  }
  conv.updated_at = now;
  if (newGeminiSid) conv.geminiSessionId = newGeminiSid;

  await Promise.all([
    putJson(`chats/${uid}/${conv.conversation_id}.json`, conv, "chat append"),
    touchIndex(uid, {
      conversation_id: conv.conversation_id,
      title: conv.title,
      updated_at: conv.updated_at,
    }),
  ]);

  return json({
    text: reply,
    user_message_id: userMessageId,
    assistant_message_id: assistantMessageId,
    conversation_id: conv.conversation_id,
    title: conv.title,
    provider,
    bot_name: bot.bot_name,
  });
}

export async function GET() {
  return json({ error: "Method tidak diizinkan" }, 405);
}
