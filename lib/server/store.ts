/* ============================================================
   Aomi — lib/server/store.ts
   Port dari lib/store.js: Upstash Redis (REST) dengan fallback
   GitHub. Interface identik dengan github.ts.
   ============================================================ */

import * as github from "./github";

const UP_URL = process.env.UPSTASH_REDIS_REST_URL;
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

export const USE_REDIS = Boolean(UP_URL && UP_TOKEN);

const keyOf = (path: string) => "aomi:" + String(path || "").replace(/^\/+/, "");

/** Kirim satu command Redis via REST. */
async function cmd(args: unknown[]): Promise<unknown> {
  const res = await fetch(UP_URL as string, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`upstash http ${res.status}`);
  const out = (await res.json()) as { error?: string; result: unknown };
  if (out.error) throw new Error("upstash: " + out.error);
  return out.result;
}

/** Decode nilai Redis → objek JS. */
function decodeValue<T>(raw: unknown): T | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return raw as T; // REST kadang sudah mengembalikan objek
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null; // data korup → anggap tidak ada
  }
}

/** Daftar path JSON di satu folder (SCAN di Redis, list dir di GitHub). */
export async function listJsonPaths(dirPath: string): Promise<string[]> {
  const clean = String(dirPath || "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!clean) return [];

  if (USE_REDIS) {
    let cursor = "0";
    const keys: string[] = [];
    let guard = 0;
    do {
      const out = (await cmd(["SCAN", cursor, "MATCH", keyOf(clean + "/*.json"), "COUNT", "300"])) as [string, string[]];
      cursor = String(out[0] ?? "0");
      for (const k of Array.isArray(out[1]) ? out[1] : []) {
        keys.push(String(k).slice("aomi:".length));
      }
    } while (cursor !== "0" && ++guard < 25);
    return keys;
  }
  return github.listPaths(clean);
}

/** Baca satu JSON → { data } | null jika tidak ada. */
export async function readJson<T = unknown>(path: string): Promise<github.JsonFile<T> | null> {
  if (!USE_REDIS) return github.readJson<T>(path);
  const data = decodeValue<T>(await cmd(["GET", keyOf(path)]));
  return data === null ? null : { data, sha: null };
}

/** Tulis JSON (Redis: SET langsung tanpa read dulu). */
export async function putJson(
  path: string,
  data: unknown,
  message = "update"
): Promise<boolean> {
  if (!USE_REDIS) return github.putJson(path, data, message);
  await cmd(["SET", keyOf(path), JSON.stringify(data)]);
  return true;
}

/** Set TTL (detik) pada sebuah key. No-op di mode GitHub. */
export async function expireJson(path: string, seconds: number): Promise<void> {
  if (!USE_REDIS) return;
  await cmd(["EXPIRE", keyOf(path), Math.max(1, Math.ceil(seconds))]);
}

/** Read-modify-write (Redis: tanpa konflik sha). */
export async function updateJson<T = unknown>(
  path: string,
  message: string,
  mutate: (current: T | null) => T | undefined,
  attempts = 3
): Promise<T | null> {
  if (!USE_REDIS) return github.updateJson<T>(path, message, mutate, attempts);
  const existing = await readJson<T>(path);
  const next = mutate(existing ? existing.data : null);
  if (next === undefined) return null;
  await putJson(path, next, message);
  return next;
}

/** Hapus satu key. */
export async function deleteJson(path: string): Promise<boolean> {
  if (!USE_REDIS) return github.deleteJson(path);
  await cmd(["DEL", keyOf(path)]);
  return true;
}

/** Kirim command Redis mentah via REST (hanya mode Redis). */
export async function redisCommand(args: unknown[]): Promise<unknown> {
  if (!USE_REDIS) throw new Error("redisCommand: mode Redis tidak aktif");
  return cmd(args);
}

/**
 * SCAN Redis untuk semua path yang cocok pola glob — bisa MENYEBAR ke
 * subfolder ("chats/*" → chats/<uid>/<file>). Return null di mode GitHub
 * (pemanggil pakai jalur fallback-nya, mis. github.listDirs).
 */
export async function scanPaths(pattern: string): Promise<string[] | null> {
  if (!USE_REDIS) return null;
  let cursor = "0";
  const keys: string[] = [];
  let guard = 0;
  do {
    const out = (await cmd(["SCAN", cursor, "MATCH", keyOf(pattern), "COUNT", "300"])) as [string, string[]];
    cursor = String(out[0] ?? "0");
    for (const k of Array.isArray(out[1]) ? out[1] : []) {
      keys.push(String(k).slice("aomi:".length));
    }
  } while (cursor !== "0" && ++guard < 100);
  return keys;
}

/** Tulis JSON hanya jika key belum ada (Redis: SET NX EX). Return true jika baru ditulis. */
export async function putJsonIfAbsent(
  path: string,
  data: unknown,
  ttlSeconds: number
): Promise<boolean> {
  if (USE_REDIS) {
    const out = (await cmd([
      "SET",
      keyOf(path),
      JSON.stringify(data),
      "NX",
      "EX",
      Math.max(1, Math.ceil(ttlSeconds)),
    ])) as string | null;
    return out === "OK";
  }
  // Mode GitHub: best-effort read-then-write (race kecil diterima, didokumentasikan).
  const existing = await github.readJson(path);
  if (existing) return false;
  await github.putJson(path, data, "put if absent");
  return true;
}

/** Hapus banyak key sekaligus (Redis: 1 DEL multi-key per chunk). */
export async function deleteMany(paths: string[]): Promise<number> {
  if (!paths.length) return 0;
  if (!USE_REDIS) {
    let n = 0;
    for (const p of paths) {
      if (await github.deleteJson(p)) n++;
    }
    return n;
  }
  let deleted = 0;
  for (let i = 0; i < paths.length; i += 100) {
    const chunk = paths.slice(i, i + 100).map(keyOf);
    const out = (await cmd(["DEL", ...chunk])) as number;
    deleted += Number(out) || 0;
  }
  return deleted;
}
