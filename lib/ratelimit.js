// ============================================================
// Aomi — api/lib/ratelimit.js
// Rate limiter sederhana in-memory (best-effort per instance).
// Brute force login ditangani lebih ketat lewat file lock di repo.
// ============================================================

const hits = new Map();

/**
 * true jika aksi BOLEH dilanjutkan, false jika melewati batas.
 * key   → mis. 'ip:1.2.3.4' atau 'register:1.2.3.4'
 * max   → jumlah maksimum dalam window
 * windowMs → panjang window
 */
export function allow(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    hits.set(key, arr);
    return false;
  }
  arr.push(now);
  hits.set(key, arr);
  if (hits.size > 5000) hits.clear();
  return true;
}

export function clientIp(headers) {
  const fwd = headers['x-forwarded-for'];
  return (typeof fwd === 'string' ? fwd.split(',')[0].trim() : '') || 'anon';
}
