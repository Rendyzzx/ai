// ============================================================
// Aomi — api/dl.js (Vercel Serverless Function)
// Proxy unduh media TikTok (video MP4 / audio MP3 / foto slide).
//
// Kenapa perlu: link CDN TikTok kalau dibuka langsung hanya
// DIPUTAR di browser (Content-Disposition: inline) — tombol
// "unduh" di kartu downloader memakai endpoint ini supaya file
// benar-benar terunduh sebagai attachment.
//
// GET /api/dl?url=<media-url>&name=<filename>[&sid=<session-id>]
//
// - Wajib login. Anchor <a> tidak bisa kirim header X-Session-Id,
//   jadi session id boleh lewat query ?sid= (divalidasi sama).
// - Allowlist hostname KETAT (anti SSRF): hanya CDN TikTok.
//   Link Instagram (rapidcdn) sudah punya flag unduh bawaan
//   (dl=1) → tidak lewat proxy ini.
// - Buffer dengan cap ukuran (respons serverless terbatas);
//   file melebihi cap → error jelas, buka link aslinya.
// ============================================================

import { getSession } from '../lib/auth.js';
import { allow, clientIp } from '../lib/ratelimit.js';

// Hanya CDN TikTok yang boleh di-proxy
const ALLOWED_HOSTS = [
  /^([a-z0-9-]+\.)?tiktokcdn\.com$/i,
  /^([a-z0-9-]+\.)?tiktokcdn-us\.com$/i,
  /^([a-z0-9-]+\.)?tiktokcdn-eu\.com$/i,
  /^([a-z0-9-]+\.)?tiktok\.com$/i,
  /^([a-z0-9-]+\.)?byteoversea\.com$/i
];

const MAX_BYTES = 30_000_000;      // ~30MB cap buffer unduhan
const MAX_SECONDS = 60;            // batas waktu ambil dari CDN

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method tidak diizinkan' });
  }

  // Session: dari header (fetch klien) atau ?sid= (link unduh anchor)
  const sid = String(req.query?.sid || '');
  const session = await getSession(
    /^[a-f0-9]{64}$/.test(sid) ? { headers: { 'x-session-id': sid } } : req
  );
  if (!session) {
    return res.status(401).json({ error: 'Sesi berakhir. Login ulang dulu ya.' , code: 'SESSION_INVALID' });
  }

  if (!allow('dl:' + clientIp(req.headers), 15, 60_000)) {
    return res.status(429).json({ error: 'Terlalu banyak unduhan. Tunggu sebentar.' });
  }

  // Validasi URL target (allowlist hostname, wajib https)
  let target;
  try {
    target = new URL(String(req.query?.url || ''));
  } catch {
    return res.status(400).json({ error: 'URL tidak valid' });
  }
  if (target.protocol !== 'https:' || !ALLOWED_HOSTS.some((re) => re.test(target.hostname))) {
    return res.status(400).json({ error: 'Sumber unduhan tidak diizinkan' });
  }

  // Nama file rapi (anti header injection)
  let name = String(req.query?.name || '');
  if (!/^[a-z0-9 ._()-]{1,64}$/i.test(name)) name = 'aomi-download.mp4';

  // Ambil dari CDN
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MAX_SECONDS * 1000);
  let upstream;
  try {
    upstream = await fetch(target.href, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0' }
    });
  } catch {
    return res.status(504).json({ error: 'Gagal mengambil file (timeout). Linknya mungkin sudah kedaluwarsa — kirim ulang linknya ya.' });
  } finally {
    clearTimeout(timer);
  }

  if (!upstream.ok || !upstream.body) {
    return res.status(502).json({ error: 'Link unduhan sudah kedaluwarsa. Kirim ulang linknya ya.' });
  }

  const len = Number(upstream.headers.get('content-length') || 0);
  if (len > MAX_BYTES) {
    return res.status(413).json({ error: 'Filenya terlalu besar untuk diunduh lewat sini.' });
  }

  const buf = Buffer.from(await upstream.arrayBuffer());
  if (!buf.length) {
    return res.status(502).json({ error: 'File kosong. Coba lagi ya.' });
  }
  if (buf.length > MAX_BYTES) {
    return res.status(413).json({ error: 'Filenya terlalu besar untuk diunduh lewat sini.' });
  }

  // Content-type dari upstream (mp4 / mpeg / jpeg) — whitelist dasar
  let mime = String(upstream.headers.get('content-type') || '').split(';')[0].trim();
  if (!/^(video|audio|image)\//.test(mime)) mime = 'application/octet-stream';

  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', String(buf.length));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  return res.status(200).send(buf);
}
