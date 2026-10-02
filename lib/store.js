// ============================================================
// Aomi — lib/store.js
// Database JSON: Upstash Redis (REST API) dengan FALLBACK ke
// GitHub (lib/github.js) bila env Upstash belum diset.
//
// Mengapa Redis: GitHub Contents API punya primary rate limit
// (5000/jam) DAN secondary/abuse limit yang bisa terpicu oleh
// burst (mis. bug redirect loop) → seluruh API 500. Redis:
// 500 ribu command/bulan di free tier, tanpa konflik sha,
// tanpa GC manual (TTL untuk session).
//
// Interface SAMA PERSIS dengan lib/github.js:
//   readJson(path)  → { data } | null
//   putJson(path, data, message) → true
//   updateJson(path, message, mutate, attempts)
//   deleteJson(path)
//   expireJson(path, seconds)  (baru — TTL; no-op di mode GitHub)
// → endpoint API tidak perlu tahu storage apa yang dipakai.
//
// Mode aktif ditentukan env (Vercel → Environment Variables):
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
// Selama env belum diset → semua operasi diteruskan ke GitHub
// (situs tetap jalan; tidak ada broken deploy saat transisi).
//
// Key Redis = path lama + prefiks 'aomi:' (mis. 'aomi:users/<id>.json')
// → data hasil migrasi script scripts/migrate-github-to-redis.mjs
// langsung kompatibel.
// ============================================================

import * as github from './github.js';

const UP_URL = process.env.UPSTASH_REDIS_REST_URL;
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

export const USE_REDIS = Boolean(UP_URL && UP_TOKEN);

const keyOf = (path) => 'aomi:' + String(path || '').replace(/^\/+/, '');

/** Kirim satu command Redis via REST: ["SET", key, value] dsb. */
async function cmd(args) {
  const res = await fetch(UP_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(args)
  });
  if (!res.ok) throw new Error(`upstash http ${res.status}`);
  const out = await res.json();
  if (out.error) throw new Error('upstash: ' + out.error);
  return out.result;
}

/** Decode nilai Redis → objek JS (tangani bentuk string maupun sudah ter-parse). */
function decodeValue(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return raw; // REST kadang sudah mengembalikan objek
  try {
    return JSON.parse(raw);
  } catch {
    return null; // data korup → anggap tidak ada
  }
}

/** Daftar path JSON di satu folder (SCAN di Redis, list dir di GitHub).
 *  Dipakai endpoint pemulihan: bangun ulang _index.json riwayat
 *  dari file percakapan yang masih ada di penyimpanan. */
export async function listJsonPaths(dirPath) {
  const clean = String(dirPath || '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!clean) return [];

  if (USE_REDIS) {
    let cursor = '0';
    const keys = [];
    let guard = 0;
    do {
      const out = await cmd(['SCAN', cursor, 'MATCH', keyOf(clean + '/*.json'), 'COUNT', '300']);
      cursor = String(out[0] ?? '0');
      for (const k of Array.isArray(out[1]) ? out[1] : []) {
        keys.push(String(k).slice('aomi:'.length));
      }
    } while (cursor !== '0' && ++guard < 25);
    return keys;
  }
  return github.listPaths(clean);
}

/** Baca satu JSON → { data } | null jika tidak ada. */
export async function readJson(path) {
  if (!USE_REDIS) return github.readJson(path);
  const data = decodeValue(await cmd(['GET', keyOf(path)]));
  return data === null ? null : { data, sha: null };
}

/**
 * Tulis JSON. Redis: SET langsung — TANPA read dulu (hemat command,
 * tanpa race sha seperti GitHub Contents API). Selalu true.
 */
export async function putJson(path, data, _message = 'update') {
  if (!USE_REDIS) return github.putJson(path, data, _message);
  await cmd(['SET', keyOf(path), JSON.stringify(data)]);
  return true;
}

/** Set TTL (detik) pada sebuah key. No-op di mode GitHub. */
export async function expireJson(path, seconds) {
  if (!USE_REDIS) return;
  await cmd(['EXPIRE', keyOf(path), Math.max(1, Math.ceil(seconds))]);
}

/**
 * Read-modify-write. Di Redis tidak ada konflik sha — satu kali
 * tulis cukup (last-write-wins; risiko overwrite hanya pada dua
 * penulis PARALEL ke path sama, sangat jarang di skala ini).
 */
export async function updateJson(path, message, mutate, _attempts = 3) {
  if (!USE_REDIS) return github.updateJson(path, message, mutate, _attempts);
  const existing = await readJson(path);
  const next = mutate(existing ? existing.data : null);
  if (next === undefined) return null; // mutate minta tidak menulis
  await putJson(path, next, message);
  return next;
}

/** Hapus satu key. */
export async function deleteJson(path) {
  if (!USE_REDIS) return github.deleteJson(path);
  await cmd(['DEL', keyOf(path)]);
  return true;
}
