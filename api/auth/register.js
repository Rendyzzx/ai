// ============================================================
// POST /api/auth/register
// Body: { username, email, password, captchaToken, captchaAnswer }
// Sukses: buat user + session, kirim cookie HttpOnly.
// ============================================================

import crypto from 'node:crypto';
import { readJson, putJson, updateJson } from '../../lib/github.js';
import { allow, clientIp } from '../../lib/ratelimit.js';
import {
  hashPassword, validateCredentials, verifyCaptcha,
  createSession
} from '../../lib/auth.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method tidak diizinkan' });
  }

  const ip = clientIp(req.headers);
  if (!allow('register:' + ip, 5, 10 * 60 * 1000)) {
    return res.status(429).json({ error: 'Terlalu banyak percobaan. Coba lagi nanti.' });
  }

  const b = req.body || {};
  const username = String(b.username || '').trim();
  const email = String(b.email || '').trim().toLowerCase();
  const password = b.password;

  if (!verifyCaptcha(b.captchaToken, b.captchaAnswer)) {
    return res.status(400).json({ error: 'Jawaban verifikasi salah atau kedaluwarsa.' });
  }

  const errors = validateCredentials(username, email, password);
  if (errors.length) return res.status(400).json({ error: errors[0] });

  // Cek duplikat lewat indeks (tidak memuat seluruh user)
  const index = await readJson('users/_index.json');
  const idx = index?.data || { emails: {}, usernames: {} };
  if (idx.emails?.[email]) return res.status(409).json({ error: 'Email sudah terdaftar.' });
  if (idx.usernames?.[username.toLowerCase()]) {
    return res.status(409).json({ error: 'Username sudah dipakai.' });
  }

  const userId = crypto.randomUUID();
  const user = {
    id: userId,
    username,
    email,
    password_hash: hashPassword(password),
    created_at: new Date().toISOString()
  };

  await putJson(`users/${userId}.json`, user, 'user create');

  // Perbarui indeks dengan retry saat race
  await updateJson('users/_index.json', 'user index', (current) => {
    const data = current || { emails: {}, usernames: {} };
    data.emails = data.emails || {};
    data.usernames = data.usernames || {};
    data.emails[email] = userId;
    data.usernames[username.toLowerCase()] = userId;
    return data;
  });

  // Auto login setelah register: session id di body (bukan cookie)
  let session;
  try {
    session = await createSession(userId, true);
  } catch {
    // Akun SUDAH dibuat; hanya auto-login yang gagal (session belum
    // terbaca). Jangan 201 palsu → client akan bounce. User bisa login manual.
    return res.status(500).json({ error: 'Akun dibuat, tapi sesi gagal dibuat. Silakan masuk.' });
  }
  return res.status(201).json({
    session_id: session.session_id,
    expires_at: session.expires_at,
    user: { id: userId, username, email }
  });
}
