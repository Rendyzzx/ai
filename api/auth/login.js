// ============================================================
// POST /api/auth/login
// Body: { identifier, password, remember, captchaToken, captchaAnswer }
// Anti brute force: lock 15 menit setelah 5 kegagalan (persist repo).
// ============================================================

import { readJson } from '../lib/github.js';
import { allow, clientIp } from '../lib/ratelimit.js';
import {
  verifyPassword, verifyCaptcha,
  createSession,
  getLoginLock, recordLoginFail, clearLoginLock
} from '../lib/auth.js';

const GENERIC_FAIL = 'Email/username atau password salah.';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method tidak diizinkan' });
  }

  const ip = clientIp(req.headers);
  if (!allow('login:' + ip, 10, 60 * 1000)) {
    return res.status(429).json({ error: 'Terlalu banyak percobaan. Coba lagi nanti.' });
  }

  const b = req.body || {};
  const identifier = String(b.identifier || '').trim().toLowerCase();
  const remember = Boolean(b.remember);

  if (!verifyCaptcha(b.captchaToken, b.captchaAnswer)) {
    return res.status(400).json({ error: 'Jawaban verifikasi salah atau kedaluwarsa.' });
  }

  // Terkunci sementara?
  const lock = await getLoginLock(identifier, ip);
  if (lock) {
    const mins = Math.ceil((lock.locked_until - Date.now()) / 60000);
    return res.status(429).json({
      error: `Terlalu banyak percobaan gagal. Coba lagi dalam ${mins} menit.`
    });
  }

  const fail = async (status = 401) => {
    const locked = await recordLoginFail(identifier, ip);
    if (locked) {
      return res.status(429).json({
        error: 'Terlalu banyak percobaan gagal. Akun terkunci 15 menit.'
      });
    }
    return res.status(status).json({ error: GENERIC_FAIL });
  };

  if (!identifier || typeof b.password !== 'string') return fail(400);

  // Cari user via indeks (tanpa memuat semua user)
  const index = await readJson('users/_index.json');
  const idx = index?.data || {};
  const userId = idx.emails?.[identifier] || idx.usernames?.[identifier];
  if (!userId) return fail();

  const userFile = await readJson(`users/${userId}.json`);
  if (!userFile) return fail();

  const user = userFile.data;
  if (!verifyPassword(b.password, user.password_hash)) return fail();

  // Sukses → bersihkan lock, buat session
  await clearLoginLock(identifier, ip);
  // Session id dikirim di body → client simpan di sessionStorage.
  // TIDAK ada cookie autentikasi persisten.
  const session = await createSession(user.id, remember);
  return res.status(200).json({
    session_id: session.session_id,
    expires_at: session.expires_at,
    user: { id: user.id, username: user.username, email: user.email }
  });
}
