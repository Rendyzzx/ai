// ============================================================
// GET /api/auth/captcha → soal verifikasi manusia (token terenkripsi)
// ============================================================

import { makeCaptcha } from '../lib/auth.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method tidak diizinkan' });
  }
  const c = makeCaptcha();
  return res.status(200).json({ number: c.number, token: c.token });
}
