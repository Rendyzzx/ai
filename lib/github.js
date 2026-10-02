// ============================================================
// Aomi — api/lib/github.js
// GitHub private repo sebagai "database" JSON sederhana.
// Semua akses lewat GitHub Contents API (per file, tanpa clone).
//
// Env Vercel yang dibutuhkan:
//   GITHUB_TOKEN  → token dengan akses repo Rendyzzx/token
//
// Layout data di repo:
//   users/_index.json            → { emails: {}, usernames: {} }
//   users/<userId>.json
//   sessions/<sessionId>.json
//   chats/<userId>/_index.json    → [ {id,title,updated_at} ]
//   chats/<userId>/<chatId>.json  → percakapan lengkap
//   locks/login-<hash>.json      → anti brute force
// ============================================================

const OWNER = 'Rendyzzx';
const REPO = 'token';
const BASE = `https://api.github.com/repos/${OWNER}/${REPO}/contents`;

const apiHeaders = () => {
  const t = process.env.GITHUB_TOKEN;
  if (!t) throw new Error('GITHUB_TOKEN belum diset di Environment Variables Vercel');
  return {
    Authorization: `Bearer ${t}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'aomi-auth',
    'X-GitHub-Api-Version': '2022-11-28'
  };
};

async function ghFetch(url, options = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Baca satu file JSON → { data, sha } | null jika tidak ada. */
export async function readJson(path) {
  const res = await ghFetch(`${BASE}/${path.replace(/^\//, '')}?ref=main`, {
    headers: apiHeaders()
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`github read ${res.status}`);
  const meta = await res.json();
  return {
    data: JSON.parse(Buffer.from(meta.content, 'base64').toString('utf8')),
    sha: meta.sha
  };
}

/** Daftar path JSON di satu folder (untuk pemulihan index riwayat).
 *  404 folder (user baru) → daftar kosong. */
export async function listPaths(dirPath) {
  const clean = String(dirPath || '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!clean) return [];
  const res = await ghFetch(`${BASE}/${clean}`, { headers: apiHeaders() });
  if (!res.ok) return [];
  let out = null;
  try { out = await res.json(); } catch { return []; }
  if (!Array.isArray(out)) return [];
  return out
    .filter((f) => f && f.type === 'file' && typeof f.name === 'string' && f.name.endsWith('.json'))
    .map((f) => `${clean}/${f.name}`);
}

/** Tulis file JSON (create bila sha kosong, update bila ada). */
export async function putJson(path, data, message = 'update') {
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  const existing = await readJson(path);
  const res = await ghFetch(`${BASE}/${path.replace(/^\//, '')}`, {
    method: 'PUT',
    headers: apiHeaders(),
    body: JSON.stringify({
      message,
      content,
      ...(existing ? { sha: existing.sha } : {})
    })
  });
  if (res.status === 409 || res.status === 422) return false; // race → pemanggil retry
  if (!res.ok) throw new Error(`github write ${res.status}`);
  return true;
}

/**
 * Read-modify-write dengan retry saat race (sha conflict).
 * mutate(current) mengembalikan objek baru yang akan ditulis.
 */
export async function updateJson(path, message, mutate, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    const existing = await readJson(path);
    const next = mutate(existing ? existing.data : null);
    if (next === undefined) return null; // mutate minta tidak menulis
    const ok = await putJson(path, next, message);
    if (ok) return next;
  }
  throw new Error('konflik penulisan github');
}

/** Hapus satu file. */
export async function deleteJson(path) {
  const existing = await readJson(path);
  if (!existing) return true;
  const res = await ghFetch(`${BASE}/${path.replace(/^\//, '')}`, {
    method: 'DELETE',
    headers: apiHeaders(),
    body: JSON.stringify({ message: 'delete', sha: existing.sha })
  });
  return res.ok;
}
