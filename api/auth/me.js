// GET /api/auth/me → info user dari session cookie (untuk restore login)
import { getSession } from '../../lib/auth.js';
import { readJson } from '../../lib/store.js';
import { APP_VERSION } from '../../lib/version.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method tidak diizinkan' });
  }

  const session = await getSession(req);
  if (!session) return res.status(401).json({ error: 'Belum login' , code: 'SESSION_INVALID' });

  const userFile = await readJson(`users/${session.user_id}.json`);
  if (!userFile) return res.status(401).json({ error: 'User tidak ditemukan' , code: 'SESSION_INVALID' });

  const u = userFile.data;
  return res.status(200).json({
    user: { id: u.id, username: u.username, email: u.email },
    app_version: APP_VERSION
  });
}
