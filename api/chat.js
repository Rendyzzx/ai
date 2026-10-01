// ============================================================
// Aomi — api/chat.js (Vercel Serverless Function)
//
// Arsitektur: Frontend → Function ini → Provider AI.
// API key hanya hidup di Environment Variables Vercel
// (GROQ_API_KEY) dan tidak pernah dikirim ke browser.
//
// Urutan provider (fallback otomatis):
//   1. Gemini (scraping internal, tanpa API key)
//   2. Groq   (butuh env GROQ_API_KEY)
//   3. ChatEverywhere (fallback terakhir)
//
// Hardening:
//   - Rate limiting per IP (best-effort, in-memory per instance)
//   - Validasi & sanitasi seluruh input
//   - Timeout ketat + batas ukuran respons (anti payload raksasa)
//   - Hanya hostname fixed (cegah SSRF: tidak ada URL dari user)
//   - Error generik: tidak membocorkan path/env/debug
// ============================================================

// ---------------- Konstanta & limit ----------------

const LIMITS = {
  rateWindowMs: 60_000,
  rateMax: 15,           // maks 15 request/menit/IP
  rateMapMax: 5000,      // jaga memori instance
  messageMaxLen: 4000,
  promptMaxLen: 1000,
  maxMessages: 40,
  responseMaxLen: 8000,  // potong respons agar hemat memori
  fetchBytes: 100_000,   // batas baca body respons upstream
  geminiTimeout: 25_000,
  groqTimeout: 20_000,
  ceTimeout: 15_000
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

const GROQ_MODEL = 'llama-3.3-70b-versatile';

// ---------------- Util kecil ----------------

// fetch dengan timeout ketat + batas ukuran respons
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

// ---------------- Rate limiting (best-effort) ----------------

const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < LIMITS.rateWindowMs);
  if (arr.length >= LIMITS.rateMax) {
    hits.set(ip, arr);
    return true;
  }
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > LIMITS.rateMapMax) hits.clear();
  return false;
}

function clientIp(headers) {
  const fwd = headers['x-forwarded-for'];
  return (typeof fwd === 'string' ? fwd.split(',')[0].trim() : '') || 'anon';
}

// ---------------- Validasi body ----------------

function parseBody(body) {
  if (!body || typeof body !== 'object') return null;

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0 || messages.length > LIMITS.maxMessages) return null;

  const clean = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const content = sanitize(m.content, LIMITS.messageMaxLen);
    if (content) clean.push({ role, content });
  }
  if (clean.length === 0) return null;

  const lastUser = [...clean].reverse().find((m) => m.role === 'user');
  if (!lastUser) return null;

  let temperature = Number(body.temperature);
  if (!Number.isFinite(temperature)) temperature = 0.5;
  temperature = Math.min(Math.max(temperature, 0), 2);

  return {
    messages: clean,
    message: lastUser.content,
    prompt: sanitize(body.prompt, LIMITS.promptMaxLen),
    temperature,
    sessionId: sanitize(body.sessionId, 8192)
  };
}

// ============================================================
// PROVIDER 1 — Gemini (scraping)
// ============================================================

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
    /* sessionId rusak → mulai sesi baru */
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

async function chatGemini(input) {
  let { resumeArray, cookie } = input.sessionId
    ? decodeSessionId(input.sessionId)
    : { resumeArray: null, cookie: null };
  const instruction = input.prompt || '';

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
      /* lewati chunk yang bukan JSON */
    }
  }

  if (!parsed) throw new Error('parsing gemini gagal');

  const resume = [...parsed[1], parsed[4][0][0]];
  const text = parsed[4][0][1][0].replace(/\*\*(.+?)\*\*/g, '*$1*');

  return {
    text: text.slice(0, LIMITS.responseMaxLen),
    sessionId: encodeSessionId(resume, cookie, instruction)
  };
}

// ============================================================
// PROVIDER 2 — Groq (GROQ_API_KEY dari env Vercel)
// ============================================================

async function chatGroq(input, apiKey) {
  const messages = [];
  if (input.prompt) messages.push({ role: 'system', content: input.prompt });
  messages.push(
    ...input.messages.slice(-10).map((m) => ({
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
        model: GROQ_MODEL,
        temperature: input.temperature,
        messages
      })
    },
    LIMITS.groqTimeout
  );

  const data = JSON.parse(res.text);
  if (!res.status || res.status >= 300) throw new Error('groq ' + res.status);
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('groq: respons kosong');
  return { text: String(text).slice(0, LIMITS.responseMaxLen) };
}

// ============================================================
// PROVIDER 3 — ChatEverywhere (fallback terakhir)
// ============================================================

async function chatEverywhere(input) {
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
        messages: input.messages.map((m) => ({
          pluginId: null, content: m.content, fileList: [], role: m.role
        })),
        prompt: input.prompt,
        temperature: input.temperature,
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
    /* respons plain-text → pakai apa adanya */
  }
  return { text: text.slice(0, LIMITS.responseMaxLen) };
}

// ============================================================
// HANDLER
// ============================================================

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method tidak diizinkan' });
  }

  if (rateLimited(clientIp(req.headers))) {
    return res.status(429).json({ error: 'Terlalu banyak permintaan. Tunggu sebentar.' });
  }

  const input = parseBody(req.body);
  if (!input) {
    return res.status(400).json({ error: 'Pesan tidak valid' });
  }

  const errors = [];

  // 1) Gemini
  try {
    const out = await chatGemini(input);
    return res.status(200).json({
      text: out.text, sessionId: out.sessionId, provider: 'gemini'
    });
  } catch (err) {
    errors.push('gemini');
    console.error('[chat] gemini:', err.message);
  }

  // 2) Groq (hanya jika key tersimpan di env Vercel)
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    try {
      const out = await chatGroq(input, groqKey);
      return res.status(200).json({
        text: out.text, sessionId: null, provider: 'groq'
      });
    } catch (err) {
      errors.push('groq');
      console.error('[chat] groq:', err.message);
    }
  }

  // 3) ChatEverywhere
  try {
    const out = await chatEverywhere(input);
    return res.status(200).json({
      text: out.text, sessionId: null, provider: 'chateverywhere'
    });
  } catch (err) {
    errors.push('chateverywhere');
    console.error('[chat] ce:', err.message);
  }

  // Gagal semua → pesan generik, tanpa detail internal
  return res.status(502).json({ error: 'Semua penyedia AI sedang tidak tersedia. Coba lagi nanti.' });
}
