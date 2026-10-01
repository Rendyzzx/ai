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
  bot_avatar: 'data:image/jpeg;base64,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',
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
      next.personality = sanitize(body.personality, 3000);
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
