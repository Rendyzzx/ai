// ============================================================
// Aomi — api/chat.js (Vercel Serverless Function)
//
// Arsitektur: Browser → Function ini (session wajib) → Provider AI
//             → pesan tersimpan ke repo database per user.
//
// Urutan provider (fallback otomatis):
//   1. Gemini (scraping internal, tanpa API key)
//   2. Groq   (env GROQ_API_KEY, opsional)
//   3. ChatEverywhere (fallback terakhir)
//
// Konteks percakapan: hidup di chats/<userId>/<chatId>.json
// (termasuk sessionId Gemini) → user bisa lanjut chat lama
// kapan pun, di perangkat mana pun, tanpa kehilangan konteks.
//
// Hardening: rate limit, validasi & sanitasi input, timeout ketat,
// batas ukuran respons, hostname fixed (cegah SSRF), error generik.
// ============================================================

import crypto from 'node:crypto';
import { readJson, putJson, updateJson } from '../lib/store.js';
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
  groqTimeout: 20_000,
  ceTimeout: 15_000,
  maxMessages: 100,       // batas isi percakapan yang disimpan
  contextSend: 8          // pesan terakhir yang dikirim ke provider fallback
};

const HOSTS = {
  geminiCookie: 'https://gemini.google.com/_/BardChatUi/data/batchexecute',
  geminiChat:
    'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  chatEverywhere: 'https://chateverywhere.app/api/chat/'
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
  let parsed = null;
  for (const item of match) {
    try {
      const outer = JSON.parse(item[1]);
      const candidate = outer?.[0]?.[2];
      if (!candidate) continue;
      const inner = JSON.parse(candidate);
      if (inner?.[4]?.[0]?.[1]?.[0]) {
        parsed = inner;
        break;
      }
    } catch {
      /* lewati chunk non-JSON */
    }
  }
  if (!parsed) throw new Error('parsing gemini gagal');

  const resume = [...parsed[1], parsed[4][0][0]];
  const text = parsed[4][0][1][0].replace(/\*\*(.+?)\*\*/g, '*$1*');
  return {
    text: text.slice(0, LIMITS.responseMaxLen),
    geminiSessionId: encodeSessionId(resume, cookie, instruction)
  };
}

// ---------------- PROVIDER 2 — Groq ----------------

async function chatGroq(input, apiKey, instruction) {
  const messages = [{ role: 'system', content: instruction }];
  const history = input.messages.slice(-LIMITS.contextSend).map((m) => ({
    role: m.role, content: m.content
  }));

  // Ada gambar → model multimodal (llama-4-scout), pesan user jadi parts
  if (input.imageDataUrl) {
    for (const m of history) messages.push(m);
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: input.message },
        { type: 'image_url', image_url: { url: input.imageDataUrl } }
      ]
    });
  } else {
    messages.push(...history, { role: 'user', content: input.message });
  }

  const res = await fetchT(
    HOSTS.groq,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: input.imageDataUrl
          ? 'meta-llama/llama-4-scout-17b-16e-instruct'
          : 'llama-3.3-70b-versatile',
        temperature: 0.5,
        messages
      })
    },
    LIMITS.groqTimeout
  );
  const data = JSON.parse(res.text);
  if (res.status >= 300) throw new Error('groq ' + res.status);
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('groq kosong');
  return { text: String(text).slice(0, LIMITS.responseMaxLen) };
}

// ---------------- PROVIDER 3 — ChatEverywhere ----------------

async function chatEverywhere(input, instruction) {
  const res = await fetchT(
    HOSTS.chatEverywhere,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Origin: 'https://chateverywhere.app'
      },
      body: JSON.stringify({
        model: {
          id: 'gpt-3.5-turbo', name: 'GPT-3.5', maxLength: 12000,
          tokenLimit: 4000, completionTokenLimit: 2500, deploymentName: 'gpt-35'
        },
        messages: [
          // pesan terbaru WAJIB ikut (dulu: hanya riwayat → balasan nyasar)
          ...input.messages.slice(-LIMITS.contextSend).map((m) => ({
            pluginId: null, content: m.content, fileList: [], role: m.role
          })),
          {
            pluginId: null,
            content: input.message,
            fileList: [],
            role: 'user'
          }
        ],
        prompt: instruction,
        temperature: 0.5,
        enableConversationPrompt: false
      })
    },
    LIMITS.ceTimeout
  );
  if (res.status >= 300) throw new Error('ce ' + res.status);
  let text = res.text;
  try {
    const data = JSON.parse(res.text);
    if (data.error) throw new Error('ce error');
    text = typeof data.text === 'string' ? data.text : res.text;
  } catch (e) {
    if (String(e.message) === 'ce error') throw e;
  }
  return { text: text.slice(0, LIMITS.responseMaxLen) };
}

// ---------------- HANDLER ----------------

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

  // Coba provider berurutan (Gemini → Groq → ChatEverywhere)
  async function askProviders(input, instruction) {
    let reply = null, provider = null, geminiSid = null;

    try {
      const out = await chatGemini(input, instruction);
      reply = out.text; provider = 'gemini'; geminiSid = out.geminiSessionId;
    } catch (err) {
      console.error('[chat] gemini:', err.message);
    }

    const groqKey = process.env.GROQ_API_KEY;
    if (!reply && groqKey) {
      try {
        const out = await chatGroq(input, groqKey, instruction);
        reply = out.text; provider = 'groq';
      } catch (err) {
        console.error('[chat] groq:', err.message);
      }
    }

    if (!reply) {
      try {
        const out = await chatEverywhere(input, instruction);
        reply = out.text; provider = 'chateverywhere';
      } catch (err) {
        console.error('[chat] ce:', err.message);
      }
    }
    return { reply, provider, geminiSid };
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

    conv.messages.push(
      { message_id: crypto.randomUUID(), role: 'assistant', content: greet, timestamp: now }
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
      conversation_id: conv.conversation_id,
      title: conv.title,
      provider,
      greeting: true,
      bot_name: bot.bot_name
    });
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
  conv.messages.push(
    {
      message_id: crypto.randomUUID(), role: 'user',
      content: message, image: imageBuffer ? (imageThumb || imageDataUrl) : undefined,
      timestamp: now
    },
    { message_id: crypto.randomUUID(), role: 'assistant', content: reply, timestamp: now }
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
    conversation_id: conv.conversation_id,
    title: conv.title,
    provider,
    bot_name: bot.bot_name
  });
}
