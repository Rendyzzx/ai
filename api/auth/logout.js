// POST /api/auth/logout → hapus session di repo (client bersihkan sessionStorage)
import { destroySession } from '../lib/auth.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method tidak diizinkan' });
  }
  await destroySession(req);
  return res.status(200).json({ ok: true });
}
