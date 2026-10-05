/* ============================================================
   Aomi — lib/server/github.ts
   Port dari lib/github.js: GitHub private repo sebagai
   "database" JSON sederhana (fallback bila Upstash belum diset).
   ============================================================ */

const OWNER = "Rendyzzx";
const REPO = "token";
const BASE = `https://api.github.com/repos/${OWNER}/${REPO}/contents`;

export interface JsonFile<T = unknown> {
  data: T;
  sha: string | null;
}

function apiHeaders(): HeadersInit {
  const t = process.env.GITHUB_TOKEN;
  if (!t) throw new Error("GITHUB_TOKEN belum diset");
  return {
    Authorization: `Bearer ${t}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "aomi-auth",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function ghFetch(
  url: string,
  options: RequestInit = {},
  timeoutMs = 12000
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Baca satu file JSON → { data, sha } | null jika tidak ada. */
export async function readJson<T = unknown>(path: string): Promise<JsonFile<T> | null> {
  const res = await ghFetch(`${BASE}/${path.replace(/^\//, "")}?ref=main`, {
    headers: apiHeaders(),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`github read ${res.status}`);
  const meta = (await res.json()) as { content: string; sha: string };
  return {
    data: JSON.parse(Buffer.from(meta.content, "base64").toString("utf8")) as T,
    sha: meta.sha,
  };
}

/** Daftar path JSON di satu folder (untuk pemulihan index riwayat). */
export async function listPaths(dirPath: string): Promise<string[]> {
  const clean = String(dirPath || "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!clean) return [];
  const res = await ghFetch(`${BASE}/${clean}`, { headers: apiHeaders() });
  if (!res.ok) return [];
  let out: unknown = null;
  try {
    out = await res.json();
  } catch {
    return [];
  }
  if (!Array.isArray(out)) return [];
  return (out as Array<{ type?: string; name?: string }>)
    .filter((f) => f && f.type === "file" && typeof f.name === "string" && f.name.endsWith(".json"))
    .map((f) => `${clean}/${f.name}`);
}

/** Tulis file JSON (create bila sha kosong, update bila ada). */
export async function putJson(
  path: string,
  data: unknown,
  message = "update"
): Promise<boolean> {
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString("base64");
  const existing = await readJson(path);
  const res = await ghFetch(`${BASE}/${path.replace(/^\//, "")}`, {
    method: "PUT",
    headers: apiHeaders(),
    body: JSON.stringify({
      message,
      content,
      ...(existing ? { sha: existing.sha } : {}),
    }),
  });
  if (res.status === 409 || res.status === 422) return false; // race → pemanggil retry
  if (!res.ok) throw new Error(`github write ${res.status}`);
  return true;
}

/** Read-modify-write dengan retry saat race (sha conflict). */
export async function updateJson<T = unknown>(
  path: string,
  message: string,
  mutate: (current: T | null) => T | undefined,
  attempts = 3
): Promise<T | null> {
  for (let i = 0; i < attempts; i++) {
    const existing = await readJson<T>(path);
    const next = mutate(existing ? existing.data : null);
    if (next === undefined) return null; // mutate minta tidak menulis
    const ok = await putJson(path, next, message);
    if (ok) return next;
  }
  throw new Error("konflik penulisan github");
}

/** Hapus satu file. */
export async function deleteJson(path: string): Promise<boolean> {
  const existing = await readJson(path);
  if (!existing) return true;
  const res = await ghFetch(`${BASE}/${path.replace(/^\//, "")}`, {
    method: "DELETE",
    headers: apiHeaders(),
    body: JSON.stringify({ message: "delete", sha: existing.sha }),
  });
  return res.ok;
}

/* ============================================================
   Binary asset storage (upload dari bot Telegram).
   File gambar TIDAK pernah disimpan sebagai JSON/base64 di Redis —
   binary disimpan di repo token (path assets/site/*), Redis hanya
   menyimpan reference (lihat lib/server/siteassets.ts).
   ============================================================ */

function b64FromBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/**
 * Simpan file binary baru atau timpa yang sudah ada (bila path sama
 * sudah terisi — mis. retry webhook Telegram atau upload ulang bytes
 * yang identik, yang menghasilkan version hash sama).
 *
 * BUG LAMA: PUT selalu dikirim TANPA sha. GitHub Contents API menolak
 * create-without-sha pada path yang sudah ada → 422 "sha wasn't
 * supplied" → fungsi ini mengembalikan null → siteassets.ts melempar
 * "Gagal menyimpan file ke storage. Coba lagi." walau token & akses
 * repo valid. Sekarang: cek sha dulu, kirim bila ada, dan retry sekali
 * dengan sha terbaru kalau tetap kena 409/422 (race antar request).
 * Return sha file (untuk delete nanti).
 */
export async function putBinary(path: string, bytes: Uint8Array, message: string): Promise<string | null> {
  const clean = path.replace(/^\//, "");
  const existingSha = await shaOf(path);

  const attemptPut = async (sha: string | null): Promise<Response> =>
    ghFetch(`${BASE}/${clean}`, {
      method: "PUT",
      headers: { ...apiHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ message, content: b64FromBytes(bytes), ...(sha ? { sha } : {}) }),
    });

  let res = await attemptPut(existingSha);

  if (res.status === 409 || res.status === 422) {
    // Race: file dibuat/diubah oleh request lain di antara cek sha dan
    // PUT ini (mis. duplikat webhook Telegram). Ambil sha terbaru,
    // retry sekali — kalau masih gagal, menyerah dan lapor error.
    const retrySha = await shaOf(path);
    if (retrySha !== existingSha) {
      res = await attemptPut(retrySha);
    }
  }

  if (!res.ok) {
    console.error(`[github] putBinary http ${res.status} ${path}`);
    return null;
  }
  const out = (await res.json()) as { content?: { sha?: string } };
  return out.content?.sha ?? null;
}

/** Baca file binary → bytes | null. */
export async function getBinary(path: string): Promise<Uint8Array | null> {
  const res = await ghFetch(`${BASE}/${path.replace(/^\//, "")}?ref=main`, {
    headers: { ...apiHeaders(), Accept: "application/vnd.github.raw+json" },
  });
  if (!res.ok) {
    console.error(`[github] getBinary http ${res.status} ${path}`);
    return null;
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  return buf.length ? buf : null;
}

/** Ambil sha file binary (untuk operasi delete). Null jika tidak ada. */
async function shaOf(path: string): Promise<string | null> {
  try {
    const res = await ghFetch(`${BASE}/${path.replace(/^\//, "")}?ref=main`, {
      headers: apiHeaders(),
    });
    if (!res.ok) return null;
    const out = (await res.json()) as { sha?: string };
    return out.sha ?? null;
  } catch {
    return null;
  }
}

/** Hapus file binary (best-effort — sha dicari otomatis jika tidak ada). */
export async function deleteBinary(path: string): Promise<boolean> {
  const sha = await shaOf(path);
  if (!sha) return false;
  const res = await ghFetch(`${BASE}/${path.replace(/^\//, "")}`, {
    method: "DELETE",
    headers: { ...apiHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ message: `chore: hapus asset ${path}`, sha }),
  });
  return res.ok;
}
