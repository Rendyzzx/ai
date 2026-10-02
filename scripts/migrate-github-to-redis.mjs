// ============================================================
// Aomi — scripts/migrate-github-to-redis.mjs
// Migrasi sekali jalan: baca seluruh JSON dari repo GitHub
// 'Rendyzzx/token' (database lama) → tulis ke Upstash Redis
// (database baru, format key lib/server/store.ts: "aomi:<path>").
//
// Cara pakai (env wajib):
//   GITHUB_TOKEN               → token dengan akses repo Rendyzzx/token
//   UPSTASH_REDIS_REST_URL    → dari console Upstash (tab REST API)
//   UPSTASH_REDIS_REST_TOKEN  → idem
//
// Lalu jalankan: node scripts/migrate-github-to-redis.mjs
// Aman dijalankan berulang (SET idempoten — data sama ditimpa sama).
//
// Yang dimigrasi: users/, chats/, bots/ utuh. sessions/ hanya yang
// masih berlaku (kedaluwarsa dilewati), lengkap dengan TTL Redis.
// locks/ dilewati (efemeral, kedaluwarsa 15 menit).
// ============================================================

const OWNER = 'Rendyzzx';
const REPO = 'token';
const GH_BASE = `https://api.github.com/repos/${OWNER}/${REPO}`;

const GH_TOKEN = process.env.GITHUB_TOKEN;
const UP_URL = process.env.UPSTASH_REDIS_REST_URL;
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!GH_TOKEN || !UP_URL || !UP_TOKEN) {
  console.error('Butuh env: GITHUB_TOKEN, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN');
  process.exit(1);
}

const ghHeaders = {
  Authorization: `Bearer ${GH_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'aomi-migration'
};

async function ghGet(url) {
  const res = await fetch(url, { headers: ghHeaders });
  if (res.status === 403 || res.status === 429) {
    throw new Error('GitHub menolak (rate limit) — tunggu cooldown dulu, lalu jalankan ulang.');
  }
  if (!res.ok) throw new Error(`github ${res.status}: ${url}`);
  return res.json();
}

async function upSet(key, value) {
  const res = await fetch(UP_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['SET', key, JSON.stringify(value)])
  });
  const out = await res.json();
  if (out.error) throw new Error('upstash: ' + out.error);
}

async function upExpire(key, seconds) {
  const res = await fetch(UP_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['EXPIRE', key, Math.max(1, Math.ceil(seconds))])
  });
  const out = await res.json();
  if (out.error) throw new Error('upstash: ' + out.error);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Daftar seluruh file (1 call)
const tree = await ghGet(`${GH_BASE}/git/trees/main?recursive=1`);
const files = tree.tree.filter((t) => t.type === 'blob' && t.path.endsWith('.json'));

// 2. Pilih yang relevan
const wanted = files.filter((f) =>
  f.path.startsWith('users/') ||
  f.path.startsWith('chats/') ||
  f.path.startsWith('bots/') ||
  f.path.startsWith('sessions/')
);
console.log(`[migrasi] ${wanted.length} file JSON ditemukan (users/chats/bots/sessions)`);

// 3. Baca → tulis (jeda kecil antar call GitHub)
let ok = 0, skipped = 0, failed = [];
for (const f of wanted) {
  await sleep(100);
  let content;
  try {
    const blob = await ghGet(`${GH_BASE}/git/blobs/${f.sha}`);
    content = JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8'));
  } catch (e) {
    failed.push(f.path + ' (baca: ' + e.message + ')');
    continue;
  }

  // session kedaluwarsa → lewati
  if (f.path.startsWith('sessions/')) {
    const exp = content.expires_at;
    if (typeof exp !== 'number' || exp < Date.now()) {
      skipped++;
      continue;
    }
  }

  const key = 'aomi:' + f.path;
  try {
    await upSet(key, content);
    if (f.path.startsWith('sessions/') && typeof content.expires_at === 'number') {
      await upExpire(key, (content.expires_at - Date.now()) / 1000);
    }
    ok++;
  } catch (e) {
    failed.push(f.path + ' (tulis: ' + e.message + ')');
  }
}

console.log(`[migrasi] selesai: ${ok} file dipindah, ${skipped} session kedaluwarsa dilewati`);
if (failed.length) {
  console.log(`[migrasi] GAGAL (${failed.length}):`);
  for (const f of failed) console.log('  - ' + f);
  process.exit(1);
}
console.log('[migrasi] Semua data kini ada di Redis. Set env Upstash di Vercel → redeploy → selesai.');
