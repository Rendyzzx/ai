// ============================================================
// Aomi — api/profile.js
// Profil user: display name, username, bio, foto profil.
// Wajib login; user_id SELALU dari session (tidak pernah dari
// request body) → data user lain tidak mungkin tersentuh.
//
// GET  → profil user
// PUT  → { username?, display_name?, bio?, avatar? }
//
// Validasi backend (jangan percaya frontend):
//   - username: 3-20 [a-zA-Z0-9_], unik
//   - display_name: 1-40 karakter
//   - bio: maks 200 karakter
//   - avatar: data URL image/jpeg|png|webp, maks 200 KB,
//     dicek magic bytes → file palsu/executable ditolak
// ============================================================

import { readJson, putJson, updateJson } from '../lib/github.js';
import { getSession } from '../lib/auth.js';
import { allow, clientIp } from '../lib/ratelimit.js';

const AVATAR_MAX_BYTES = 200 * 1024;

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

function sanitize(str, maxLen) {
  return String(str ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, maxLen)
    .trim();
}

/**
 * Validasi avatar data URL (setelah dikompres klien ke 256px).
 * Return null = valid/kosong; string = pesan error.
 */
function validateAvatar(value) {
  if (value === null || value === undefined || value === '') return null; // hapus foto
  if (typeof value !== 'string') return 'Foto profil tidak valid.';

  const m = value.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return 'Foto profil harus berupa JPG, PNG, atau WebP.';
  if (value.length > AVATAR_MAX_BYTES * 1.4) return 'Foto terlalu besar.';

  let buf;
  try {
    buf = Buffer.from(m[2], 'base64');
  } catch {
    return 'Foto profil tidak valid.';
  }
  if (buf.length === 0 || buf.length > AVATAR_MAX_BYTES) {
    return 'Foto terlalu besar (maks 200 KB).';
  }

  // Magic bytes: pastikan benar-benar file gambar, bukan exe/script
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
  if (!session) return res.status(401).json({ error: 'Sesi berakhir. Silakan login kembali.' , code: 'SESSION_INVALID' });
  const uid = session.user_id;

  const userFile = await readJson(`users/${uid}.json`);
  if (!userFile) return res.status(401).json({ error: 'User tidak ditemukan' , code: 'SESSION_INVALID' });
  const user = userFile.data;

  // ---------------- GET ----------------
  if (req.method === 'GET') {
    return res.status(200).json({
      username: user.username,
      display_name: user.display_name || user.username,
      bio: user.bio || '',
      avatar: user.avatar || null
    });
  }

  // ---------------- PUT ----------------
  if (req.method === 'PUT') {
    if (!allow('profile:' + clientIp(req.headers), 10, 60 * 1000)) {
      return res.status(429).json({ error: 'Terlalu banyak perubahan. Tunggu sebentar.' });
    }

    const body = req.body || {};
    const next = { ...user };

    // Username (opsional, dicek unik)
    if (Object.prototype.hasOwnProperty.call(body, 'username')) {
      const username = String(body.username || '').trim();
      if (!USERNAME_RE.test(username)) {
        return res.status(400).json({ error: 'Username 3-20 karakter, hanya huruf, angka, dan underscore.' });
      }
      const index = await readJson('users/_index.json');
      const idx = index?.data || { emails: {}, usernames: {} };
      const owner = idx.usernames?.[username.toLowerCase()];
      if (owner && owner !== uid) {
        return res.status(409).json({ error: 'Username sudah dipakai.' });
      }
      // perbarui indeks (hapus key lama, tambah yang baru)
      await updateJson('users/_index.json', 'username index', (current) => {
        const data = current || { emails: {}, usernames: {} };
        data.usernames = data.usernames || {};
        if (user.username) delete data.usernames[String(user.username).toLowerCase()];
        data.usernames[username.toLowerCase()] = uid;
        return data;
      });
      next.username = username;
      if (!next.display_name) next.display_name = username;
    }

    if (Object.prototype.hasOwnProperty.call(body, 'display_name')) {
      const dn = sanitize(body.display_name, 40);
      if (!dn) return res.status(400).json({ error: 'Nama tampilan wajib diisi.' });
      next.display_name = dn;
    }

    if (Object.prototype.hasOwnProperty.call(body, 'bio')) {
      next.bio = sanitize(body.bio, 200);
    }

    if (Object.prototype.hasOwnProperty.call(body, 'avatar')) {
      const err = validateAvatar(body.avatar);
      if (err) return res.status(400).json({ error: err });
      next.avatar = body.avatar || null;
    }

    await putJson(`users/${uid}.json`, next, 'profile update');

    return res.status(200).json({
      username: next.username,
      display_name: next.display_name || next.username,
      bio: next.bio || '',
      avatar: next.avatar || null
    });
  }

  res.setHeader('Allow', 'GET, PUT');
  return res.status(405).json({ error: 'Method tidak diizinkan' });
}
