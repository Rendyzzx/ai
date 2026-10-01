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
import { readJson, putJson, updateJson } from './lib/github.js';
import { DEFAULT_BOT } from './bot.js';
import { getSession } from './lib/auth.js';
import { allow, clientIp } from './lib/ratelimit.js';

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
  casual: 'Gunakan nada santai dan ramah.',
  neutral: 'Gunakan nada netral dan lugas.',
  formal: 'Gunakan nada formal dan sopan.'
};

const LENGTH_PROMPTS = {
  concise: 'Jawab sangat singkat dan langsung ke inti.',
  balanced: 'Jawab ringkas dan jelas.',
  detailed: 'Jawab lengkap dan terstruktur.'
};

// System prompt dibangun dari customization user (nama, personality, dll.)
function buildInstruction(bot) {
  const name = bot.bot_name || 'Aomi';
  const parts = [`Kamu adalah ${name}, asisten chat.`];
  if (bot.bot_description) parts.push(bot.bot_description);
  if (bot.language === 'en') parts.push('Always reply in English.');
  else if (bot.language === 'id') parts.push('Selalu berbahasa Indonesia.');
  else parts.push('Balas menggunakan bahasa yang dipakai pengguna.');
  if (bot.personality) parts.push(bot.personality);
  parts.push(TONE_PROMPTS[bot.response_style] || TONE_PROMPTS.casual);
  parts.push(LENGTH_PROMPTS[bot.response_length] || LENGTH_PROMPTS.balanced);
  parts.push('Jangan gunakan format markdown berat.');
  if (bot.system_prompt) parts.push(bot.system_prompt);
  return parts.join(' ');
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

async function chatGemini(input, instruction) {
  let { resumeArray, cookie } = input.geminiSessionId
    ? decodeSessionId(input.geminiSessionId)
    : { resumeArray: null, cookie: null };

  if (!cookie) cookie = await geminiGetCookie();

  const requestBody = [
    [input.message, 0, null, null, null, null, 0],
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
  messages.push(
    ...input.messages.slice(-LIMITS.contextSend).map((m) => ({
      role: m.role, content: m.content
    }))
  );
  const res = await fetchT(
    HOSTS.groq,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
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
        messages: input.messages.slice(-LIMITS.contextSend).map((m) => ({
          pluginId: null, content: m.content, fileList: [], role: m.role
        })),
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
  if (!session) return res.status(401).json({ error: 'Sesi berakhir. Silakan login kembali.' });
  const uid = session.user_id;

  if (!allow('chat:' + clientIp(req.headers), LIMITS.rateMax, LIMITS.rateWindowMs)) {
    return res.status(429).json({ error: 'Terlalu banyak permintaan. Tunggu sebentar.' });
  }

  const body = req.body || {};
  const message = sanitize(body.message, LIMITS.messageMaxLen);
  if (!message) return res.status(400).json({ error: 'Pesan tidak valid' });

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

  const input = {
    message,
    geminiSessionId: conv.geminiSessionId,
    messages: conv.messages
  };

  // Coba provider berurutan
  let reply = null;
  let provider = null;
  let newGeminiSid = null;

  try {
    const out = await chatGemini(input, instruction);
    reply = out.text;
    provider = 'gemini';
    newGeminiSid = out.geminiSessionId;
  } catch (err) {
    console.error('[chat] gemini:', err.message);
  }

  const groqKey = process.env.GROQ_API_KEY;
  if (!reply && groqKey) {
    try {
      const out = await chatGroq(input, groqKey, instruction);
      reply = out.text;
      provider = 'groq';
    } catch (err) {
      console.error('[chat] groq:', err.message);
    }
  }

  if (!reply) {
    try {
      const out = await chatEverywhere(input, instruction);
      reply = out.text;
      provider = 'chateverywhere';
    } catch (err) {
      console.error('[chat] ce:', err.message);
    }
  }

  if (!reply) {
    return res.status(502).json({
      error: 'Semua penyedia AI sedang tidak tersedia. Coba lagi nanti.'
    });
  }

  // Simpan pesan ke percakapan user
  const now = new Date().toISOString();
  conv.messages.push(
    { message_id: crypto.randomUUID(), role: 'user', content: message, timestamp: now },
    { message_id: crypto.randomUUID(), role: 'assistant', content: reply, timestamp: now }
  );
  if (conv.title === 'Chat baru') {
    conv.title = message.slice(0, 48);
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
