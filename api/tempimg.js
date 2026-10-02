// ============================================================
// Aomi — api/tempimg.js (Vercel Serverless Function)
// Host gambar SEMENTARA dengan URL publik.
//
// Kenapa perlu: API edit foto eksternal (api-faa.my.id) mengambil
// gambar masukan via URL publik — browser hanya punya dataURL.
// Jadi: kirim gambar → disimpan sebentar di sini → dapat URL →
// URL itulah yang "ditembakkan" ke API edit. Hasil edit juga
// disimpan di sini untuk masa unduh (TTL 3 hari).
//
// GET /api/tempimg?id=<id>               → tampilkan gambar
// GET /api/tempimg?id=<id>&dl=1&name=x.png → unduh sebagai lampiran
//
// Keamanan: ID unguessable (uuid) sebagai capability URL — siapa
// pun yang punya link bisa melihat gambar (memang harus begitu,
// karena server api-faa yang mengambilnya). MIME di-whitelist,
// ID divalidasi (anti key-injection), global header sudah nosniff.
//
// Penyimpanan: lib/store.js (Redis + TTL; mode fallback GitHub
// tanpa TTL — file menetap sampai dibersihkan manual).
// ============================================================

import { readJson } from '../lib/store.js';

const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const ID_RE = /^[a-z0-9-]{8,64}$/;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method tidak diizinkan' });
  }

  const id = String(req.query?.id || '');
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'ID tidak valid' });

  const file = await readJson(`tempimg/${id}.json`);
  const rec = file?.data;
  if (!rec || typeof rec.b64 !== 'string' || !ALLOWED_MIME.includes(rec.mime)) {
    return res.status(404).json({ error: 'Gambar tidak ditemukan / sudah kedaluwarsa' });
  }

  let buf;
  try {
    buf = Buffer.from(rec.b64, 'base64');
  } catch {
    return res.status(404).json({ error: 'Gambar tidak valid' });
  }
  if (!buf.length) return res.status(404).json({ error: 'Gambar kosong' });

  res.setHeader('Content-Type', rec.mime);
  res.setHeader('Content-Length', String(buf.length));
  // Live selama masa sewa key Redis; browser boleh cache 1 jam.
  res.setHeader('Cache-Control', 'public, max-age=3600');

  // Mode unduhan: nama file rapi (bukan .bin mentah dari API luar)
  if (req.query?.dl === '1') {
    let name = String(req.query?.name || '');
    if (!/^[a-z0-9._-]{1,64}$/i.test(name)) name = 'aomi-edit.' + (rec.mime === 'image/png' ? 'png' : 'jpg');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  }

  return res.status(200).send(buf);
}
