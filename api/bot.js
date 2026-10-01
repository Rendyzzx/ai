// ============================================================
// Aomi — api/bot.js
// Customization bot per user: identitas, personality, perilaku.
//
// Data: bots/<user_id>.json — terisolasi per akun (user_id hanya
// dari session, tidak pernah dari request body).
//
// GET → konfigurasi bot user (merge dengan default)
// PUT → field yang berubah saja:
//   { bot_name?, bot_description?, bot_avatar?, personality_preset?,
//     personality?, system_prompt?, language?, response_length?,
//     response_style? }
// ============================================================

import { readJson, putJson } from './lib/github.js';
import { getSession } from './lib/auth.js';
import { allow, clientIp } from './lib/ratelimit.js';

const AVATAR_MAX_BYTES = 200 * 1024;

export const DEFAULT_BOT = {
  bot_name: 'Aomi',
  bot_description: 'Asisten AI pribadimu.',
  bot_avatar: null,
  personality_preset: 'friendly',
  personality: '',
  system_prompt: '',
  language: 'auto',
  response_length: 'balanced',
  response_style: 'casual'          // nada bicara: casual | neutral | formal
};

const LANGUAGES = ['auto', 'id', 'en'];
const LENGTHS = ['concise', 'balanced', 'detailed'];
const STYLES = ['casual', 'neutral', 'formal'];
const PRESETS = ['friendly', 'professional', 'creative', 'custom'];

function sanitize(str, maxLen) {
  return String(str ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, maxLen)
    .trim();
}

function validateAvatar(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return 'Avatar bot tidak valid.';
  const m = value.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return 'Avatar harus berupa JPG, PNG, atau WebP.';
  if (value.length > AVATAR_MAX_BYTES * 1.4) return 'Avatar terlalu besar.';
  let buf;
  try { buf = Buffer.from(m[2], 'base64'); } catch { return 'Avatar tidak valid.'; }
  if (buf.length === 0 || buf.length > AVATAR_MAX_BYTES) return 'Avatar terlalu besar (maks 200 KB).';
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const isWebp = buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
                buf.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!isJpg && !isPng && !isWebp) return 'File bukan gambar yang valid.';
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const session = await getSession(req);
  if (!session) return res.status(401).json({ error: 'Sesi berakhir. Silakan login kembali.' });
  const uid = session.user_id;

  const botPath = `bots/${uid}.json`;
  const existing = await readJson(botPath);
  const current = { ...DEFAULT_BOT, ...(existing?.data || {}) };

  // ---------------- GET ----------------
  if (req.method === 'GET') {
    return res.status(200).json({ bot: current });
  }

  // ---------------- PUT ----------------
  if (req.method === 'PUT') {
    if (!allow('bot:' + clientIp(req.headers), 10, 60 * 1000)) {
      return res.status(429).json({ error: 'Terlalu banyak perubahan. Tunggu sebentar.' });
    }

    const body = req.body || {};
    const next = { ...current };

    if (Object.prototype.hasOwnProperty.call(body, 'bot_name')) {
      const name = sanitize(body.bot_name, 40);
      if (!name) return res.status(400).json({ error: 'Nama bot wajib diisi.' });
      next.bot_name = name;
    }

    if (Object.prototype.hasOwnProperty.call(body, 'bot_description')) {
      next.bot_description = sanitize(body.bot_description, 120);
    }

    if (Object.prototype.hasOwnProperty.call(body, 'bot_avatar')) {
      const err = validateAvatar(body.bot_avatar);
      if (err) return res.status(400).json({ error: err });
      next.bot_avatar = body.bot_avatar || null;
    }

    if (Object.prototype.hasOwnProperty.call(body, 'personality_preset')) {
      if (!PRESETS.includes(body.personality_preset)) {
        return res.status(400).json({ error: 'Preset personality tidak valid.' });
      }
      next.personality_preset = body.personality_preset;
    }

    if (Object.prototype.hasOwnProperty.call(body, 'personality')) {
      next.personality = sanitize(body.personality, 300);
    }

    if (Object.prototype.hasOwnProperty.call(body, 'system_prompt')) {
      next.system_prompt = sanitize(body.system_prompt, 1000);
    }

    if (Object.prototype.hasOwnProperty.call(body, 'language')) {
      if (!LANGUAGES.includes(body.language)) {
        return res.status(400).json({ error: 'Bahasa tidak valid.' });
      }
      next.language = body.language;
    }

    if (Object.prototype.hasOwnProperty.call(body, 'response_length')) {
      if (!LENGTHS.includes(body.response_length)) {
        return res.status(400).json({ error: 'Panjang jawaban tidak valid.' });
      }
      next.response_length = body.response_length;
    }

    if (Object.prototype.hasOwnProperty.call(body, 'response_style')) {
      if (!STYLES.includes(body.response_style)) {
        return res.status(400).json({ error: 'Nada bicara tidak valid.' });
      }
      next.response_style = body.response_style;
    }

    await putJson(botPath, next, 'bot settings update');
    return res.status(200).json({ bot: next });
  }

  res.setHeader('Allow', 'GET, PUT');
  return res.status(405).json({ error: 'Method tidak diizinkan' });
}
