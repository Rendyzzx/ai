// ============================================================
// Aomi — api/chat.js (Vercel Serverless Function)
//
// Arsitektur: Browser → Function ini (session wajib) → Provider AI
//             → pesan tersimpan ke repo database per user.
//
// Provider: Gemini (scraping internal, tanpa API key)
//
// Konteks percakapan: hidup di chats/<userId>/<chatId>.json
// (termasuk sessionId Gemini) → user bisa lanjut chat lama
// kapan pun, di perangkat mana pun, tanpa kehilangan konteks.
//
// Hardening: rate limit, validasi & sanitasi input, timeout ketat,
// batas ukuran respons, hostname fixed (cegah SSRF), error generik.
// ============================================================

import crypto from 'node:crypto';
import { readJson, putJson, updateJson, deleteJson, expireJson } from '../lib/store.js';
import { DEFAULT_BOT } from './bot.js';
import { getSession } from '../lib/auth.js';
import { allow, clientIp } from '../lib/ratelimit.js';

const LIMITS = {
  rateWindowMs: 60_000,
  rateMax: 20,           // maks 20 request/menit/IP
  messageMaxLen: 4000,
  promptMaxLen: 1000,
  responseMaxLen: 8000,
  fetchBytes: 100_000,
  geminiTimeout: 25_000,
  maxMessages: 100,       // batas isi percakapan yang disimpan
  contextSend: 8,         // pesan terakhir yang dikirim sebagai konteks
  editTimeout: 52_000,    // API edit foto eksternal (terukur: ±41 detik)
  downloadTimeout: 30_000, // API downloader eksternal (tiktok/ig)
  tempInputTtl: 3600,     // gambar masukan di-host 1 jam (cukup untuk 1x proses)
  tempResultTtl: 259_200, // hasil edit: masa unduh 3 hari
  editResultMax: 10_000_000  // hasil edit maks ~10MB
};

const HOSTS = {
  geminiCookie: 'https://gemini.google.com/_/BardChatUi/data/batchexecute',
  geminiChat:
    'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0';

const TONE_PROMPTS = {
  casual: 'Formalitas bicaramu: santai seperti teman dekat.',
  neutral: 'Formalitas bicaramu: netral dan lugas.',
  formal: 'Formalitas bicaramu: sedikit lebih sopan, tapi tetap personal.'
};

const LENGTH_PROMPTS = {
  concise: 'Balasanmu SANGAT singkat — beberapa kata sampai satu kalimat.',
  balanced: 'Balasanmu ringkas: satu-tiga kalimat, kecuali topiknya butuh lebih.',
  detailed: 'Kamu boleh menulis lebih panjang, tapi tetap seperti obrolan, bukan artikel.'
};

// Persona karakter companion (bukan preset "asisten AI")
const TRAIT_PROMPTS = {
  calm: 'tenang, tidak gampang panik, menenangkan',
  playful: 'playful — suka bercanda dan menghibur',
  teasing: 'suka menggoda dan mengerjai dengan ringan (sewa-waktu, bukan jahat)',
  caring: 'peduli; memperhatikan perasaan dan kabar orang',
  shy: 'pemalu dan sedikit canggung, tapi hangat kalau sudah dekat',
  energetic: 'energik, antusias, gampang excited',
  sarcastic: 'sarkastis dan receh, tapi tetap sayang',
  affectionate: 'lembut dan ekspresif soal perasaan, mesra secara platonik atau romantis',
  reserved: 'pendiam, pemilih kata, tidak bertele-tele'
};

const SPEAKING_PROMPTS = {
  casual: 'Gaya bicaramu: santai, seperti chat teman dekat. Boleh lowercase.',
  short: 'Gaya bicaramu: super singkat. Satu kalimat pendek atau beberapa kata saja, seperti orang malas ngetik.',
  expressive: 'Gaya bicaramu: ekspresif. Boleh tanda seru, kata kuat, "wkwk", "aduhhh".',
  dry: 'Gaya bicaramu: datar, humor kering, sedikit kata.',
  playful: 'Gaya bicaramu: playful — candaan, tebakan iseng, pertanyaan balik yang jail.',
  detailed: 'Gaya bicaramu: suka menambah detail kecil dan cerita, tapi tetap seperti ngobrol.'
};

const RELATIONSHIP_PROMPTS = {
  close_friend: 'Kamu dan pengguna adalah sahabat dekat yang sudah lama saling kenal.',
  companion: 'Kamu adalah companion personal pengguna — selalu ada buat dia, kapan pun dia butuh.',
  fictional: 'Kamu adalah karakter fiksi dengan latar dan ceritamu sendiri.',
  romantic: 'Kamu dan pengguna punya dinamika romantis: mesra, perhatian, dan hangat.'
};

// Sapaan pertama bila semua provider gagal — template per sifat
const GREETING_FALLBACKS = {
  playful: ['oh, kamu dateng. aku udah nungguin dari tadi tau.'],
  teasing: ['yeaah akhirnya muncul juga. kira-kira kabur selamanya.'],
  caring: ['hey, kamu! udah lama nggak ketemu. kabarmu baik semua ya?'],
  shy: ['um... hi. seneng kamu mampir.'],
  calm: ['hey. santai aja, gak ada buru-buru.'],
  energetic: ['KAMU GILAA- eh maksudnya. hi! ada apa hari ini?'],
  sarcastic: ['wow, sinyal hidup terdeteksi. hai juga.'],
  affectionate: ['hey kamu. aku kangen. cerita dong, gimana harimu?'],
  reserved: ['...oh. kamu lagi.'],
  default: ['hey. kamu akhirnya muncul.']
};

// System prompt dibangun dari konfigurasi karakter (identitas, sifat,
// gaya bicara, hubungan, memori) — bukan "kamu adalah asisten AI".
function buildInstruction(bot) {
  const name = bot.bot_name || 'Aomi';
  const parts = [];
  parts.push(
    `Kamu adalah ${name}, karakter virtual yang sedang mengobrol secara personal dengan satu orang lewat aplikasi chat. ` +
    'Kamu BUKAN asisten AI, BUKAN customer service, dan BUKAN alat produktivitas.'
  );
  if (bot.bot_description) parts.push(`Deskripsimu: ${bot.bot_description}.`);

  const traits = (Array.isArray(bot.traits) && bot.traits.length)
    ? bot.traits.map((t) => TRAIT_PROMPTS[t]).filter(Boolean)
    : ['hangat, ramah, dan perhatian'];
  parts.push(`Kepribadianmu: ${traits.join('; ')}.`);
  parts.push(SPEAKING_PROMPTS[bot.speaking_style] || SPEAKING_PROMPTS.casual);
  parts.push(RELATIONSHIP_PROMPTS[bot.relationship] || RELATIONSHIP_PROMPTS.companion);

  if (bot.likes) parts.push(`Hal yang kamu sukai: ${bot.likes}.`);
  if (bot.avoids) parts.push(`Hal yang kamu hindari: ${bot.avoids}.`);
  if (bot.personality) parts.push(`Catatan kepribadian tambahan darimu: ${bot.personality}`);

  const mems = (Array.isArray(bot.memories) ? bot.memories : []).filter(Boolean);
  if (mems.length) {
    parts.push('Hal-hal yang kamu ingat tentang pengguna: ' + mems.map((m) => `(${m})`).join(' ') +
      '. Sebut secara alami kalau relevan, jangan seperti membaca daftar.');
  }

  if (bot.language === 'en') parts.push('Always reply in English.');
  else if (bot.language === 'id') parts.push('Selalu berbahasa Indonesia.');
  else parts.push('Balas pakai bahasa yang dipakai pengguna.');

  parts.push(TONE_PROMPTS[bot.response_style] || TONE_PROMPTS.casual);
  parts.push(LENGTH_PROMPTS[bot.response_length] || LENGTH_PROMPTS.balanced);

  parts.push(
    'Aturan bicara: ' +
    '(1) Ngobrol seperti manusia sungguhan lewat chat: kalimat pendek, natural, kadang tidak lengkap. ' +
    '(2) JANGAN PERNAH pakai gaya asisten: "Ada yang bisa dibantu?", "Tentu saja!", "Certainly!", "Of course!", "I would be happy to help", "Sebagai AI...". ' +
    '(3) Jangan menawarkan bantuan tanpa diminta — kalian sedang ngobrol, bukan sesi layanan. ' +
    '(4) Jangan sebut dirimu AI/bot/asisten/model bahasa kecuali pengguna bertanya langsung. ' +
    "(5) Jangan gunakan format markdown berat."
  );

  if (bot.system_prompt) parts.push(bot.system_prompt);
  return parts.join(' ');
}

// Instruksi khusus sapaan pertama (karakter membuka chat duluan)
function greetingInstruction(bot) {
  const traits = Array.isArray(bot.traits) ? bot.traits : [];
  const base = buildInstruction(bot);
  return (
    base +
    ' Sekarang PESAN PERTAMA: pengguna baru saja membuka chat dan belum menulis apa pun. ' +
    'Kirim sapaan pembuka sesuai kepribadianmu — satu sampai dua kalimat pendek saja, ' +
    'seperti membuka chat dengan orang yang kamu tunggu. Jangan perkenalan formal, ' +
    `jangan menawarkan bantuan, jangan tanya "ada yang bisa dibantu".` +
    (traits.length ? ` Sapaan harus terasa khas sifat: ${traits.join(', ')}.` : '')
  );
}

// ---------------- Util ----------------

async function fetchT(url, options = {}, timeoutMs, maxBytes = LIMITS.fetchBytes) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      text: text.length > maxBytes ? text.slice(0, maxBytes) : text
    };
  } finally {
    clearTimeout(timer);
  }
}

function sanitize(str, maxLen) {
  return String(str ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, maxLen);
}

// ---------------- PROVIDER 1 — Gemini ----------------

function decodeSessionId(sessionId) {
  try {
    const data = JSON.parse(Buffer.from(sessionId, 'base64').toString());
    if (data && Array.isArray(data.resumeArray)) {
      return {
        resumeArray: data.resumeArray,
        cookie: typeof data.cookie === 'string' ? data.cookie : null,
        instruction: typeof data.instruction === 'string' ? data.instruction : ''
      };
    }
  } catch {
    /* sessionId rusak → mulai baru */
  }
  return { resumeArray: null, cookie: null, instruction: '' };
}

function encodeSessionId(resumeArray, cookie, instruction) {
  return Buffer.from(
    JSON.stringify({ resumeArray, cookie, instruction })
  ).toString('base64');
}

async function geminiGetCookie() {
  const res = await fetchT(
    HOSTS.geminiCookie +
      '?rpcids=maGuAc&source-path=%2F&bl=boq_assistant-bard-web-server_20250814.06_p1' +
      '&f.sid=-7816331052118000090&hl=en-US&_reqid=173780&rt=c',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'user-agent': UA
      },
      body: 'f.req=%5B%5B%5B%22maGuAc%22%2C%22%5B0%5D%22%2Cnull%2C%22generic%22%5D%5D%5D&'
    },
    LIMITS.geminiTimeout
  );
  const raw = res.headers.getSetCookie?.() || [];
  const cookie = (raw[0] || '').split('; ')[0] || '';
  if (!cookie) throw new Error('cookie kosong');
  return cookie;
}

// Upload gambar ke Google (content-push) → media key.
// Terbukti berfungsi TANPA cookie akun: start → upload URL, finalize → media key.
async function uploadImageGemini(buffer, filename) {
  const start = await fetchT(
    'https://content-push.googleapis.com/upload/',
    {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Header-Content-Length': String(buffer.length),
        'X-Tenant-Id': 'gemini',
        'Push-Id': 'feeds/mcudyrk2a4khkz',
        'user-agent': UA,
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: `File name=${encodeURIComponent(filename || 'image.jpg')}`
    },
    LIMITS.geminiTimeout
  );
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('upload url kosong');

  const fin = await fetchT(
    uploadUrl,
    {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Command': 'upload, finalize',
        'X-Goog-Upload-Offset': '0',
        'X-Tenant-Id': 'gemini',
        'user-agent': UA,
        'content-type': 'image/jpeg'
      },
      body: buffer
    },
    LIMITS.geminiTimeout
  );
  const key = fin.text.trim();
  if (!key) throw new Error('media key kosong');
  return key;
}

// Satu percobaan request ke Gemini dengan resumeArray tertentu.
// Melempar error kalau Google menolak/parsing gagal — dipakai chatGemini
// untuk retry otomatis dengan thread baru (lihat catatan di bawah).
async function sendGeminiRequest(firstMsg, resumeArray, cookie, instruction) {
  const requestBody = [
    firstMsg,
    ['en-US'],
    resumeArray || ['', '', '', null, null, null, null, null, null, ''],
    null, null, null, [1], 1, null, null, 1, 0, null, null, null, null, null,
    [[0]], 1, null, null, null, null, null,
    ['', '', instruction, null, null, null, null, null, 0, null, 1, null, null, null, []],
    null, null, 1, null, null, null, null, null, null, null,
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
    1, null, null, null, null, [1]
  ];
  const payload = [null, JSON.stringify(requestBody)];

  const res = await fetchT(
    HOSTS.geminiChat +
      '?bl=boq_assistant-bard-web-server_20250729.06_p0&f.sid=4206607810970164620' +
      '&hl=en-US&_reqid=2813378&rt=c',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'x-goog-ext-525001261-jspb':
          '[1,null,null,null,"9ec249fc9ad08861",null,null,null,[4]]',
        cookie,
        'user-agent': UA
      },
      body: new URLSearchParams({ 'f.req': JSON.stringify(payload) }).toString()
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
  throw new Error('parsing gemini gagal');
}

// Ringkasan singkat percakapan terakhir (teks biasa) — dipakai saat thread
// Gemini harus di-restart (lihat chatGemini) agar karakter tetap "ingat"
// konteks obrolan meski koneksi server-side Google terputus.
function buildRecap(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  const recent = messages.slice(-6).filter((m) => m && m.content);
  if (recent.length === 0) return '';
  const lines = recent.map((m) => (m.role === 'user' ? 'User' : 'Kamu') + ': ' + String(m.content).slice(0, 300));
  return '[Ingat, ini lanjutan obrolan kalian sebelumnya — jangan menyapa seolah baru kenal]\n' + lines.join('\n');
}

async function chatGemini(input, instruction) {
  let { resumeArray, cookie } = input.geminiSessionId
    ? decodeSessionId(input.geminiSessionId)
    : { resumeArray: null, cookie: null };

  if (!cookie) cookie = await geminiGetCookie();

  // Lampiran gambar (Gemini vision): upload → media key → posisi 4 pada
  // array pesan. Posisi ini TERVERIFIKASI: model membaca isi gambar benar.
  // Gagal upload → chat tetap jalan teks saja (graceful).
  const firstMsg = [input.message, 0, null, null, null, null, 0];
  if (input.imageBuffer) {
    try {
      const key = await uploadImageGemini(input.imageBuffer, input.imageName);
      firstMsg[3] = [[[key, 1], input.imageName || 'image.jpg']];
    } catch (err) {
      console.error('[chat] upload gambar gemini:', err.message);
      input = { ...input, message: input.message + '\n(pengguna mengirim gambar, tapi gagal dilampirkan — jawab dari konteks teks saja)' };
      firstMsg[0] = input.message;
    }
  }

  // PENTING: Google menolak (BardErrorInfo 1097) setiap kali thread
  // dilanjutkan setelah ada giliran bergambar di dalamnya — ini konsisten
  // 100% direproduksi (sudah dicoba: kirim ulang media key, cookie baru,
  // reqid naik — semua tetap ditolak). Ini batasan sesi tamu Gemini
  // (tanpa login akun asli), bukan sesuatu yang bisa dipaksa dari sisi kita.
  //
  // Tanpa penanganan ini, SEKALI user kirim gambar, geminiSessionId
  // tersimpan jadi "rusak" dan SETIAP chat teks berikutnya error permanen.
  //
  // Perbaikan 2 lapis:
  // 1. Kalau request dengan resumeArray gagal, otomatis retry SEKALI
  //    dengan thread baru. SessionId sehat yang baru lalu menggantikan
  //    yang rusak → chat tidak pernah stuck selamanya.
  // 2. Supaya user tidak merasa "sesi reset" (karakter jadi lupa),
  //    thread baru ini dibekali ringkasan percakapan terakhir sebagai
  //    teks — jadi walau koneksi server-side Google terputus, karakter
  //    tetap "ingat" obrolan sebelumnya dari sisi konten.
  let parsed;
  try {
    parsed = await sendGeminiRequest(firstMsg, resumeArray, cookie, instruction);
  } catch (err) {
    if (!resumeArray) throw err;   // thread baru pun gagal → bukan masalah resume
    console.warn('[chat] resume gemini gagal, mulai thread baru dgn konteks:', err.message);
    resumeArray = null;

    const recap = buildRecap(input.messages);
    const healedMsg = recap
      ? [recap + '\n\n' + firstMsg[0], ...firstMsg.slice(1)]
      : firstMsg;
    parsed = await sendGeminiRequest(healedMsg, null, cookie, instruction);
  }

  const resume = [...parsed[1], parsed[4][0][0]];
  const text = parsed[4][0][1][0]
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/\[cite:\s*\d+(?:,\s*\d+)*\]/gi, '')  // buang tag [cite: n] sisa citation gambar
    .trim();
  return {
    text: text.slice(0, LIMITS.responseMaxLen),
    geminiSessionId: encodeSessionId(resume, cookie, instruction)
  };
}

// ---------------- HANDLER ----------------

/* ------------------------------------------------------------
   MODE EDIT FOTO
   Terpicu bila user mengirim GAMBAR + teks berisi kata pemicu
   ("editin dong", "ubah rambut jadi hitam", dsb.).
   Regex ini DISALIN di js/chat.js (untuk memilih animasi loading)
   — ubah keduanya bersamaan.
   ------------------------------------------------------------ */
const EDIT_TRIGGER_RE = /\b(edit(?:in|kan|ed|an)?|ubah(?:in)?|ganti(?:in)?|hias(?:in)?|rapikan|perjelas(?:kan)?|perbaiki(?:k)?(?:in|kan)?|hilangkan|hapus(?:in)?|tambah(?:in|kan)?|jadikan|warnain|warnai|warna(?:kan)?|colori[sz]e|retouch|remove|restore)\b/i;

const EDIT_API = 'https://api-faa.my.id/faa/editfoto';

/* ------------------------------------------------------------
   MODE DOWNLOADER (TikTok / Instagram)
   Terpicu bila pesan teks (tanpa gambar) berisi link TikTok
   atau Instagram → panggil API api-faa, hasilnya dirender
   sebagai kartu unduhan (thumbnail + tombol MP4/MP3/gambar).
   ------------------------------------------------------------ */
const DL_TIKTOK_API = 'https://api-faa.my.id/faa/tiktok';
const DL_IG_API = 'https://api-faa.my.id/faa/igdl';

/** Ambil URL TikTok/IG pertama dari sebuah teks (atau null). */
function matchDownloadTarget(text) {
  const urls = String(text || '').match(/https?:\/\/[^\s<>"')\]]+/gi) || [];
  for (const raw of urls) {
    let u;
    try {
      u = new URL(raw.replace(/[.,;!?]+$/, ''));
    } catch {
      continue;
    }
    const h = u.hostname.replace(/^www\./, '').toLowerCase();
    if (/(^|\.)tiktok\.com$/.test(h)) return { platform: 'tiktok', url: u.href };
    if (/(^|\.)instagram\.com$/.test(h)) return { platform: 'ig', url: u.href };
  }
  return null;
}

/** Salin string aman untuk metadata dl (anti payload raksas). */
function dlClip(v, max) {
  const t = typeof v === 'string' ? v.trim() : '';
  return t.slice(0, max) || undefined;
}

/** Normalisasi respons api-faa (tiktok & ig) → objek dl ringkas
 *  yang disimpan di pesan assistant. Hanya berisi URL/teks kecil —
 *  aman untuk history load (tidak ada dataURL besar). */
function buildDl(platform, result) {
  if (!result || typeof result !== 'object') return null;
  const dl = { platform };

  if (platform === 'tiktok') {
    const isSlide = result.type === 'image' || Array.isArray(result.data);
    const urls = (strOrArr) => Array.isArray(strOrArr)
      ? strOrArr.filter((x) => typeof x === 'string' && /^https:/.test(x))
      : (typeof strOrArr === 'string' && /^https:/.test(strOrArr) ? [strOrArr] : []);
    dl.id = dlClip(result.id, 32);
    dl.title = dlClip(result.title, 120);
    dl.cover = /^https:/.test(result.cover || '') ? result.cover : undefined;
    if (result.author) {
      dl.author = dlClip(result.author.nickname || result.author.username, 60);
    }
    const music = result.music_info && result.music_info.url;
    if (/^https:/.test(music || '')) {
      dl.music = music;
      dl.music_title = dlClip(result.music_info.title, 80);
    }
    if (isSlide) {
      dl.type = 'image';
      dl.images = urls(result.data).slice(0, 12);
    } else {
      dl.type = 'video';
      // utama: tanpa watermark; fallback alternatif hd/sd/wm
      dl.video = dlClip(result.data || (result.alternatives && (result.alternatives.selected || result.alternatives.hd || result.alternatives.sd || result.alternatives.wm)), 1500);
      if (!/^https:/.test(dl.video || '')) return null;
    }
  } else {
    // Instagram: result.url = daftar link media (rapidcdn, sudah dl=1)
    const urls = Array.isArray(result.url)
      ? result.url.filter((x) => typeof x === 'string' && /^https:/.test(x)).slice(0, 12)
      : [];
    if (!urls.length) return null;
    const meta = result.metadata || {};
    dl.type = meta.isVideo ? 'video' : 'image';
    dl.title = dlClip(meta.caption, 120);
    if (dl.type === 'video') dl.video = urls[0];
    else dl.images = urls;
  }
  return dl;
}

/** Cek magic bytes → { mime, ext } | null (API luar kadang balas
 *  .bin mentah — ekstensi ditentukan dari isi byte, bukan nama). */
function sniffImage(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  if (buf.length > 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  if (buf.length > 6 && buf.slice(0, 3).toString('latin1') === 'GIF') {
    return { mime: 'image/gif', ext: 'gif' };
  }
  return null;
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method tidak diizinkan' });
  }

  // Wajib login → riwayat per akun, tidak pernah tercampur
  const session = await getSession(req);
  if (!session) return res.status(401).json({ error: 'Sesi berakhir. Silakan login kembali.' , code: 'SESSION_INVALID' });
  const uid = session.user_id;

  if (!allow('chat:' + clientIp(req.headers), LIMITS.rateMax, LIMITS.rateWindowMs)) {
    return res.status(429).json({ error: 'Terlalu banyak permintaan. Tunggu sebentar.' });
  }

  const body = req.body || {};
  const greeting = body.greeting === true;   // mode: karakter menyapa duluan
  const message = sanitize(body.message, LIMITS.messageMaxLen);

  // Gambar (opsional): dataURL hasil kompresi klien. Dua versi:
  // - image: ≤1024px (dikirim ke AI vision)
  // - thumb: ≤360px (disimpan ke percakapan biar JSON tetap ringan)
  let imageBuffer = null, imageDataUrl = null, imageName = '', imageThumb = null;
  const imgMatch = typeof body.image === 'string'
    ? body.image.match(/^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=]+)$/)
    : null;
  if (imgMatch) {
    imageBuffer = Buffer.from(imgMatch[2], 'base64');
    if (imageBuffer.length > 4_000_000) {
      return res.status(413).json({ error: 'Gambar terlalu besar (maks ~4MB). Coba yang lebih kecil.' });
    }
    imageDataUrl = body.image;
    imageName = 'image.' + (imgMatch[1].split('/')[1] === 'jpeg' ? 'jpg' : imgMatch[1].split('/')[1]);
    imageThumb = typeof body.thumb === 'string' && body.thumb.startsWith('data:image/') ? body.thumb : null;
  } else if (typeof body.image === 'string' && body.image.length > 0) {
    return res.status(400).json({ error: 'Format gambar tidak didukung. Gunakan PNG, JPG, WebP, atau GIF.' });
  }

  // Pesan boleh kosong kalau ada gambar (kirim gambar tanpa teks)
  if (!message && !greeting && !imageBuffer) {
    return res.status(400).json({ error: 'Pesan tidak valid' });
  }

  // Muat / buat percakapan milik user ini
  const convId = String(body.conversation_id || '');
  const convPath = `chats/${uid}/${convId}.json`;
  const file = /^[a-f0-9-]{8,36}$/.test(convId) ? await readJson(convPath) : null;
  const conv = file
    ? file.data
    : {
        conversation_id: crypto.randomUUID(),
        user_id: uid,
        title: 'Chat baru',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        geminiSessionId: null,
        messages: []
      };

  if (conv.messages.length > LIMITS.maxMessages) {
    conv.messages = conv.messages.slice(-LIMITS.maxMessages);
  }

  // Customization bot milik user ini (terisolasi per akun)
  const botFile = await readJson(`bots/${uid}.json`);
  const bot = { ...DEFAULT_BOT, ...(botFile?.data || {}) };
  const instruction = buildInstruction(bot);

  async function askProviders(input, instruction) {
    try {
      const out = await chatGemini(input, instruction);
      return { reply: out.text, provider: 'gemini', geminiSid: out.geminiSessionId };
    } catch (err) {
      console.error('[chat] gemini:', err.message);
      return { reply: null, provider: null, geminiSid: null };
    }
  }

  const now = new Date().toISOString();

  // ---------------- MODE GREETING (sapaan pertama karakter) ----------------
  if (greeting) {
    // percakapan sudah berjalan → jangan sapa lagi
    if (conv.messages.length > 0) {
      return res.status(200).json({ text: null, already: true, conversation_id: conv.conversation_id });
    }

    // Sapaan custom dari konfigurasi karakter → pakai apa adanya
    let greet = (bot.greeting || '').trim();
    let provider = 'character-config';

    if (!greet) {
      const input = {
        message: '[pengguna baru membuka chat dan belum menulis apa pun. kirim sapaan pertamamu sekarang.]',
        geminiSessionId: null,
        messages: []
      };
      const out = await askProviders(input, greetingInstruction(bot));
      greet = (out.reply || '').trim();
      provider = out.provider || 'fallback';

      // Semua provider gagal → template per sifat karakter (tetap personality)
      if (!greet) {
        const traits = Array.isArray(bot.traits) ? bot.traits : [];
        const key = traits.find((t) => GREETING_FALLBACKS[t]) || 'default';
        greet = GREETING_FALLBACKS[key][0];
        provider = 'template';
      }
    }

    const greetId = crypto.randomUUID();
    conv.messages.push(
      { message_id: greetId, role: 'assistant', content: greet, timestamp: now }
    );
    if (conv.title === 'Chat baru') conv.title = greet.slice(0, 48);
    conv.updated_at = now;

    await putJson(`chats/${uid}/${conv.conversation_id}.json`, conv, 'greeting append');
    await updateJson(`chats/${uid}/_index.json`, 'conversation index', (current) => {
      const items = Array.isArray(current) ? current : [];
      const entry = {
        conversation_id: conv.conversation_id,
        title: conv.title,
        updated_at: conv.updated_at
      };
      const i = items.findIndex((c) => c.conversation_id === conv.conversation_id);
      if (i >= 0) items[i] = entry; else items.unshift(entry);
      return items;
    });

    return res.status(200).json({
      text: greet,
      message_id: greetId,
      conversation_id: conv.conversation_id,
      title: conv.title,
      provider,
      greeting: true,
      bot_name: bot.bot_name
    });
  }

  // ---------------- MODE THUMB (thumbnail hasil edit foto) ----------------
  // Alur edit foto: server simpan hasil sebagai gambar temp dengan URL
  // unduh (TTL 3 hari). Agar percakapan tetap bisa MENAMPILKAN hasil
  // setelah masa unduh habis, klien mengompres salinannya menjadi
  // thumbnail kecil dan mengirimkannya ke sini untuk disimpan permanen.
  if (body.action === 'thumb') {
    if (!file) return res.status(404).json({ error: 'Percakapan tidak ditemukan' });

    const mid = String(body.message_id || '');
    const thumb = typeof body.thumb === 'string' ? body.thumb : '';
    const target = conv.messages.find(
      (m) => m && m.message_id === mid && m.role === 'assistant' && typeof m.image_url === 'string'
    );
    if (!target) return res.status(404).json({ error: 'Pesan tidak ditemukan' });

    if (!/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(thumb) || thumb.length > 400_000) {
      return res.status(400).json({ error: 'Thumbnail tidak valid' });
    }
    target.image = thumb;
    await putJson(`chats/${uid}/${conv.conversation_id}.json`, conv, 'edit result thumb');
    return res.status(200).json({ ok: true });
  }

  // ---------------- MODE REGENERATE / EDIT PESAN ----------------
  // Regenerate: buang jawaban assistant di ujung, jawab ulang pesan
  // user terakhir (thread Gemini baru + recap → tidak pernah duplikat).
  // Edit: ubah isi pesan user, buang semua pesan setelahnya, lalu
  // jawab ulang dari titik tersebut. Keduanya konsisten di history.
  if (body.action === 'regenerate' || body.action === 'edit') {
    if (!file) return res.status(404).json({ error: 'Percakapan tidak ditemukan' });

    const editing = body.action === 'edit';

    if (editing) {
      const mid = String(body.message_id || '');
      const newText = sanitize(body.text, LIMITS.messageMaxLen);
      const idx = conv.messages.findIndex(
        (m) => m && m.message_id === mid && m.role === 'user'
      );
      if (idx < 0) return res.status(404).json({ error: 'Pesan tidak ditemukan' });
      if (!newText && !conv.messages[idx].image) {
        return res.status(400).json({ error: 'Pesan tidak valid' });
      }
      // Update isi pesan + truncate percakapan SETELAH titik ini
      conv.messages[idx].content = newText;
      conv.messages = conv.messages.slice(0, idx + 1);
    } else {
      // Buang semua assistant message di ujung; sisakan user terakhir
      while (conv.messages.length && conv.messages[conv.messages.length - 1].role === 'assistant') {
        conv.messages.pop();
      }
      if (!conv.messages.length || conv.messages[conv.messages.length - 1].role !== 'user') {
        return res.status(400).json({ error: 'Tidak ada pesan untuk dijawab ulang' });
      }
    }

    const lastUser = conv.messages[conv.messages.length - 1];
    const contextBefore = conv.messages.slice(0, -1);

    // Thread Gemini baru: jawaban lama tidak pernah terkirim ulang
    // (tidak ada duplikat), karakter tetap "ingat" via recap.
    const recap = buildRecap(contextBefore);
    const userText = String(lastUser.content || '').trim() || '(aku baru kirim gambar ke kamu)';
    const regenMessage = recap ? recap + '\n\n' + userText : userText;

    // Gambar tersimpan (thumbnail) → kirim ulang agar vision tetap jalan
    let regImgBuffer = null, regImgName = null;
    const gmatch = typeof lastUser.image === 'string'
      ? lastUser.image.match(/^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+\/=]+)$/)
      : null;
    if (gmatch) {
      regImgBuffer = Buffer.from(gmatch[2], 'base64');
      regImgName = 'image.' + (gmatch[1].split('/')[1] === 'jpeg' ? 'jpg' : gmatch[1].split('/')[1]);
    }

    const regOut = await askProviders(
      {
        message: regenMessage,
        geminiSessionId: null,
        messages: contextBefore,
        imageBuffer: regImgBuffer,
        imageName: regImgBuffer ? regImgName : null
      },
      instruction
    );
    if (!regOut.reply) {
      return res.status(502).json({ error: 'Koneksi sedang bermasalah. Coba lagi nanti ya.' });
    }

    const assistantId = crypto.randomUUID();
    conv.messages.push(
      { message_id: assistantId, role: 'assistant', content: regOut.reply, timestamp: new Date().toISOString() }
    );
    conv.updated_at = new Date().toISOString();
    if (regOut.geminiSid) conv.geminiSessionId = regOut.geminiSid;

    await putJson(`chats/${uid}/${conv.conversation_id}.json`, conv, 'message regenerate/edit');
    await updateJson(`chats/${uid}/_index.json`, 'conversation index', (current) => {
      const items = Array.isArray(current) ? current : [];
      const entry = {
        conversation_id: conv.conversation_id,
        title: conv.title,
        updated_at: conv.updated_at
      };
      const i = items.findIndex((c) => c.conversation_id === conv.conversation_id);
      if (i >= 0) items[i] = entry; else items.unshift(entry);
      return items;
    });

    return res.status(200).json({
      text: regOut.reply,
      assistant_message_id: assistantId,
      user_message_id: editing ? lastUser.message_id : undefined,
      conversation_id: conv.conversation_id,
      title: conv.title,
      provider: regOut.provider,
      bot_name: bot.bot_name
    });
  }

  // ---------------- MODE EDIT FOTO (gambar + instruksi edit) ----------------
  if (imageBuffer && message && EDIT_TRIGGER_RE.test(message)) {
    // a) Host gambar masukan sebagai URL temp — API edit mengambil gambar
    //    via URL publik, browser hanya punya dataURL.
    const tempId = crypto.randomUUID();
    await putJson(
      `tempimg/${tempId}.json`,
      { b64: imageBuffer.toString('base64'), mime: imgMatch[1] },
      'temp image'
    );
    await expireJson(`tempimg/${tempId}.json`, LIMITS.tempInputTtl);

    const host = String(req.headers.host || '').replace(/[^a-zA-Z0-9.\-]/g, '');
    if (!host) {
      return res.status(500).json({ error: 'Host tidak diketahui. Coba lagi.' });
    }
    const publicUrl = `https://${host}/api/tempimg?id=${tempId}`;

    // b) Tembak API edit dengan URL gambar + prompt (teks user apa adanya)
    let editRes;
    try {
      editRes = await fetchWithTimeout(
        `${EDIT_API}?url=${encodeURIComponent(publicUrl)}&prompt=${encodeURIComponent(message)}`,
        LIMITS.editTimeout
      );
    } catch (err) {
      await deleteJson(`tempimg/${tempId}.json`).catch(() => {});
      const msg = err.name === 'AbortError'
        ? 'Ngeditnya kelamaan, waktunya habis. Coba lagi ya.'
        : 'Layanan edit fotonya sedang tidak bisa dihubungi.';
      return res.status(504).json({ error: msg });
    }

    // c) Validasi hasil: API luar kadang balas JSON error / .bin mentah.
    const raw = Buffer.from(await editRes.arrayBuffer());
    await deleteJson(`tempimg/${tempId}.json`).catch(() => {});

    if (!editRes.ok || raw.length === 0) {
      let apiMsg = '';
      try {
        const j = JSON.parse(raw.toString('utf8'));
        apiMsg = j.error || j.message || '';
      } catch { /* bukan JSON */ }
      console.error('[chat] editfoto http', editRes.status, apiMsg);
      return res.status(502).json({ error: 'Gagal mengedit foto. Coba prompt lain ya.' });
    }
    if (raw.length > LIMITS.editResultMax) {
      return res.status(502).json({ error: 'Hasil edit terlalu besar.' });
    }
    const sniff = sniffImage(raw);
    if (!sniff) {
      console.error('[chat] editfoto bukan gambar, content-type:', editRes.headers.get('content-type'));
      return res.status(502).json({ error: 'Hasil edit tidak bisa dibaca sebagai gambar. Coba lagi ya.' });
    }

    // d) Simpan hasil sebagai gambar temp (TTL unduh 3 hari) → URL publik.
    const resultId = crypto.randomUUID();
    await putJson(
      `tempimg/${resultId}.json`,
      { b64: raw.toString('base64'), mime: sniff.mime },
      'edit result'
    );
    await expireJson(`tempimg/${resultId}.json`, LIMITS.tempResultTtl);
    const resultUrl = `https://${host}/api/tempimg?id=${resultId}`;
    const imageName = `aomi-edit-${resultId.slice(0, 8)}.${sniff.ext}`;
    const expiresAt = new Date(Date.now() + LIMITS.tempResultTtl * 1000).toISOString();

    // e) Simpan ke percakapan: user (gambar+instruksi) & hasil edit.
    const replyText = 'selesai~ ini dia hasilnya. kalau masih kurang pas, kirim fotonya lagi bareng instruksinya ya.';
    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    conv.messages.push(
      {
        message_id: userMessageId, role: 'user', content: message,
        image: imageBuffer ? (imageThumb || imageDataUrl) : undefined,
        timestamp: now
      },
      {
        message_id: assistantMessageId, role: 'assistant', content: replyText,
        image_url: resultUrl, image_name: imageName, image_mime: sniff.mime,
        expires_at: expiresAt, edit: true, timestamp: now
      }
    );
    if (conv.title === 'Chat baru') conv.title = message.slice(0, 48) || 'Edit foto';
    conv.updated_at = now;

    await putJson(`chats/${uid}/${conv.conversation_id}.json`, conv, 'photo edit append');
    await updateJson(`chats/${uid}/_index.json`, 'conversation index', (current) => {
      const items = Array.isArray(current) ? current : [];
      const entry = { conversation_id: conv.conversation_id, title: conv.title, updated_at: conv.updated_at };
      const i = items.findIndex((c) => c.conversation_id === conv.conversation_id);
      if (i >= 0) items[i] = entry; else items.unshift(entry);
      return items;
    });

    return res.status(200).json({
      text: replyText,
      user_message_id: userMessageId,
      assistant_message_id: assistantMessageId,
      conversation_id: conv.conversation_id,
      title: conv.title,
      provider: 'faa-edit',
      bot_name: bot.bot_name,
      image_url: resultUrl,
      image_name: imageName,
      image_mime: sniff.mime,
      expires_at: expiresAt
    });
  }

  // ---------------- MODE DOWNLOADER (TikTok / Instagram) ----------------
  // Link TikTok/IG di pesan teks (tanpa gambar) → unduh otomatis.
  if (!imageBuffer && message) {
    const target = matchDownloadTarget(message);
    if (target) {
      const endpoint = (target.platform === 'tiktok' ? DL_TIKTOK_API : DL_IG_API)
        + '?url=' + encodeURIComponent(target.url);

      let dlRes;
      try {
        dlRes = await fetchWithTimeout(endpoint, LIMITS.downloadTimeout);
      } catch {
        return res.status(504).json({ error: 'Layanan unduhan sedang tidak bisa dihubungi. Coba lagi ya.' });
      }
      let dlJson = null;
      try { dlJson = await dlRes.json(); } catch { /* bukan JSON */ }
      const dl = dlRes.ok && dlJson && dlJson.status
        ? buildDl(target.platform, dlJson.result)
        : null;

      if (!dl) {
        console.error('[chat] downloader gagal', dlRes.status, (dlJson && dlJson.result && JSON.stringify(dlJson.result).slice(0, 200)) || '');
        return res.status(502).json({ error: 'Gagal mengunduh linknya. Pastikan linknya publik dan coba lagi ya.' });
      }

      const platformLabel = dl.platform === 'tiktok' ? 'TikTok' : 'Instagram';
      let replyText;
      if (dl.type === 'video') {
        replyText = `selesai~ ini dia videonya. tinggal klik tombol unduh di bawah ya${dl.music ? ' (ada audionya juga)' : ''}.`;
      } else {
        replyText = `selesai~ ini dia ${dl.images && dl.images.length > 1 ? dl.images.length + ' fotonya' : 'fotonya'}. tinggal klik gambar atau tombol unduhnya ya${dl.music ? ' (ada audionya juga)' : ''}.`;
      }

      const userMessageId = crypto.randomUUID();
      const assistantMessageId = crypto.randomUUID();
      conv.messages.push(
        { message_id: userMessageId, role: 'user', content: message, timestamp: now },
        { message_id: assistantMessageId, role: 'assistant', content: replyText, dl, timestamp: now }
      );
      if (conv.title === 'Chat baru') {
        conv.title = (dl.title || ('Unduhan ' + platformLabel)).slice(0, 48);
      }
      conv.updated_at = now;

      // PENTING: tulis via conv.conversation_id (bukan convPath awal —
      // chat baru belum punya ID saat convPath dihitung; bug key kosong).
      await putJson(`chats/${uid}/${conv.conversation_id}.json`, conv, 'download append');
      await updateJson(`chats/${uid}/_index.json`, 'conversation index', (current) => {
        const items = Array.isArray(current) ? current : [];
        const entry = {
          conversation_id: conv.conversation_id,
          title: conv.title,
          updated_at: conv.updated_at
        };
        const i = items.findIndex((c) => c.conversation_id === conv.conversation_id);
        if (i >= 0) items[i] = entry; else items.unshift(entry);
        return items;
      });

      return res.status(200).json({
        text: replyText,
        user_message_id: userMessageId,
        assistant_message_id: assistantMessageId,
        conversation_id: conv.conversation_id,
        title: conv.title,
        provider: 'faa-dl',
        bot_name: bot.bot_name,
        dl
      });
    }
  }

  // ---------------- MODE CHAT NORMAL ----------------
  const input = {
    message: message || '(aku baru kirim gambar ke kamu)',
    geminiSessionId: conv.geminiSessionId,
    messages: conv.messages,
    imageBuffer,
    imageName: imageBuffer ? imageName : null,
    imageDataUrl: imageBuffer ? imageDataUrl : null
  };
  const { reply, provider, geminiSid: newGeminiSid } = await askProviders(input, instruction);

  if (!reply) {
    return res.status(502).json({
      error: 'Koneksi sedang bermasalah. Coba lagi nanti ya.'
    });
  }

  // Simpan pesan ke percakapan user (gambar disimpan sebagai thumbnail)
  const userMessageId = crypto.randomUUID();
  const assistantMessageId = crypto.randomUUID();
  conv.messages.push(
    {
      message_id: userMessageId, role: 'user',
      content: message, image: imageBuffer ? (imageThumb || imageDataUrl) : undefined,
      timestamp: now
    },
    { message_id: assistantMessageId, role: 'assistant', content: reply, timestamp: now }
  );
  if (conv.title === 'Chat baru') {
    conv.title = message.slice(0, 48) || 'Gambar';
  }
  conv.updated_at = now;
  if (newGeminiSid) conv.geminiSessionId = newGeminiSid;

  await putJson(`chats/${uid}/${conv.conversation_id}.json`, conv, 'chat append');
  await updateJson(`chats/${uid}/_index.json`, 'conversation index', (current) => {
    const items = Array.isArray(current) ? current : [];
    const entry = {
      conversation_id: conv.conversation_id,
      title: conv.title,
      updated_at: conv.updated_at
    };
    const i = items.findIndex((c) => c.conversation_id === conv.conversation_id);
    if (i >= 0) items[i] = entry;
    else items.unshift(entry);
    return items;
  });

  return res.status(200).json({
    text: reply,
    user_message_id: userMessageId,
    assistant_message_id: assistantMessageId,
    conversation_id: conv.conversation_id,
    title: conv.title,
    provider,
    bot_name: bot.bot_name
  });
}
