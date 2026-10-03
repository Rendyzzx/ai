/* ============================================================
   Aomi — lib/server/adminsvc.ts
   Service untuk menu admin Telegram: status database, user,
   monitoring, security, cleanup, export. Dipakai handler bot
   (bukan handler yang akses storage langsung).
   ============================================================ */

import {
  listJsonPaths,
  readJson,
  putJson,
  updateJson,
  deleteMany,
  redisCommand,
  USE_REDIS,
} from "./store";
import { KEYS } from "@/lib/redis/keys";
import { getMaintenanceState } from "./maintenance";
import { getFlags, type FeatureFlags } from "./features";

// ---------------- Database ----------------

export interface DbStatus {
  provider: "Upstash Redis" | "GitHub (fallback)";
  ok: boolean;
  latencyMs: number;
}

export async function dbStatus(): Promise<DbStatus> {
  const start = Date.now();
  let ok = true;
  try {
    await readJson(KEYS.healthcheck);
  } catch {
    ok = false;
  }
  return {
    provider: USE_REDIS ? "Upstash Redis" : "GitHub (fallback)",
    ok,
    latencyMs: Date.now() - start,
  };
}

/** Info Redis yang aman (tanpa kredensial). Null jika mode fallback. */
export async function redisInfo(): Promise<{
  latencyMs: number;
  keys: number | null;
  memory: string | null;
  version: string | null;
} | null> {
  if (!USE_REDIS) return null;
  const start = Date.now();
  try {
    const size = (await redisCommand(["DBSIZE"])) as number;
    const info = String((await redisCommand(["INFO", "memory"])) || "");
    const memory = (info.match(/used_memory_human:([^\r\n]+)/) || [])[1]?.trim() || null;
    const server = String((await redisCommand(["INFO", "server"])) || "");
    const version = (server.match(/redis_version:([^\r\n]+)/) || [])[1]?.trim() || null;
    return { latencyMs: Date.now() - start, keys: Number(size) || 0, memory, version };
  } catch {
    return { latencyMs: Date.now() - start, keys: null, memory: null, version: null };
  }
}

/** Cleanup state bot Telegram (sesi & penanda update — aman dihapus kapan pun). */
export async function cleanupBotState(): Promise<number> {
  const seen = await listJsonPaths("telegram/seen").catch(() => [] as string[]);
  const sessions = await listJsonPaths("telegram/session").catch(() => [] as string[]);
  const all = [...seen, ...sessions];
  if (!all.length) return 0;
  return await deleteMany(all).catch(() => 0);
}

/** Revoke SEMUA sesi website (login semua user hangus). Owner + konfirmasi. */
export async function revokeAllSessions(): Promise<number> {
  const paths = await listJsonPaths("sessions").catch(() => [] as string[]);
  if (!paths.length) return 0;
  return await deleteMany(paths).catch(() => 0);
}

// ---------------- Users ----------------

interface StoredUser {
  id: string;
  username?: string;
  email?: string;
  created_at?: string;
  suspended?: boolean;
  suspended_at?: string;
}

export interface UserSummary {
  id: string;
  username: string;
  created_at: string;
  suspended: boolean;
}

async function readUser(id: string): Promise<StoredUser | null> {
  const file = await readJson<StoredUser>(`users/${id}.json`).catch(() => null);
  return file?.data || null;
}

async function userIndex(): Promise<{ emails?: Record<string, string>; usernames?: Record<string, string> }> {
  const file = await readJson<{ emails?: Record<string, string>; usernames?: Record<string, string> }>(
    "users/_index.json"
  ).catch(() => null);
  return file?.data || {};
}

/** Cari user: email / username / uuid. Maks 5 hasil. */
export async function searchUsers(query: string): Promise<UserSummary[]> {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  const idx = await userIndex();

  // Langsung by uuid
  if (/^[0-9a-f-]{36}$/i.test(q)) {
    const u = await readUser(q);
    return u ? [summarize(u)] : [];
  }
  // By email persis / username persis
  const byEmail = idx.emails?.[q];
  const byUsername = idx.usernames?.[q];
  if (byEmail || byUsername) {
    const u = await readUser(String(byEmail || byUsername));
    return u ? [summarize(u)] : [];
  }
  // Prefix scan (maks 5)
  const out: UserSummary[] = [];
  for (const [email, id] of Object.entries(idx.emails || {})) {
    if (email.startsWith(q) && out.length < 5) {
      const u = await readUser(id);
      if (u) out.push(summarize(u));
    }
  }
  for (const [uname, id] of Object.entries(idx.usernames || {})) {
    if (uname.startsWith(q) && out.length < 5 && !out.some((o) => o.id === id)) {
      const u = await readUser(id);
      if (u) out.push(summarize(u));
    }
  }
  return out.slice(0, 5);
}

function summarize(u: StoredUser): UserSummary {
  return {
    id: u.id,
    username: u.username || "(tanpa username)",
    created_at: u.created_at || "",
    suspended: u.suspended === true,
  };
}

/** User terdaftar paling akhir (indeks disimpan berurutan insert). */
export async function recentUsers(n = 5): Promise<UserSummary[]> {
  const idx = await userIndex();
  const entries = Object.entries(idx.emails || {}).slice(-n).reverse();
  const out: UserSummary[] = [];
  for (const [, id] of entries) {
    const u = await readUser(id);
    if (u) out.push(summarize(u));
  }
  return out;
}

export interface UserStats {
  total: number;
  suspended: number;
  sessions: number;
  tempimg: number;
  activeLocks: number;
}

export async function userStats(): Promise<UserStats> {
  const idx = await userIndex();
  const suspendedIds = await suspendedList();
  const [sessions, tempimg, locks] = await Promise.all([
    listJsonPaths("sessions").catch(() => [] as string[]),
    listJsonPaths("tempimg").catch(() => [] as string[]),
    listJsonPaths("locks").catch(() => [] as string[]),
  ]);
  return {
    total: Object.keys(idx.emails || {}).length,
    suspended: suspendedIds.length,
    sessions: sessions.length,
    tempimg: tempimg.length,
    activeLocks: locks.length,
  };
}

export async function userDetail(id: string): Promise<UserSummary | null> {
  const u = await readUser(id);
  return u ? summarize(u) : null;
}

// ---------------- Suspend ----------------

let suspCache: { ids: string[]; at: number } | null = null;
const SUSP_CACHE_MS = 30_000;

export async function suspendedList(): Promise<string[]> {
  if (suspCache && Date.now() - suspCache.at < SUSP_CACHE_MS) return suspCache.ids;
  const file = await readJson<{ ids?: string[] }>(KEYS.suspendedUsers).catch(() => null);
  const ids = Array.isArray(file?.data?.ids) ? (file!.data!.ids as string[]) : [];
  suspCache = { ids, at: Date.now() };
  return ids;
}

export function resetSuspendedCache(): void {
  suspCache = null;
}

/** Cek cepat untuk gate login/chat (cache 30 detik). */
export async function isUserSuspended(uid: string): Promise<boolean> {
  const ids = await suspendedList();
  return ids.includes(uid);
}

async function setSuspended(uid: string, suspended: boolean): Promise<boolean> {
  const user = await readUser(uid);
  if (!user) return false;
  const next: StoredUser = { ...user, suspended };
  if (suspended) next.suspended_at = new Date().toISOString();
  else delete next.suspended_at;
  await putJson(`users/${uid}.json`, next, suspended ? "user suspend" : "user unsuspend");
  await updateJson<{ ids: string[] }>(KEYS.suspendedUsers, "suspended list", (current) => {
    const ids = Array.isArray(current?.ids) ? current!.ids.filter((x) => x !== uid) : [];
    if (suspended) ids.push(uid);
    return { ids };
  });
  resetSuspendedCache();
  return true;
}

export async function suspendUser(uid: string): Promise<boolean> {
  return setSuspended(uid, true);
}

export async function unsuspendUser(uid: string): Promise<boolean> {
  return setSuspended(uid, false);
}

// ---------------- Monitoring ----------------

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

let aiCache: { ok: boolean; at: number } | null = null;

/** Probe nyata ke provider AI (cached 60 detik) — status jujur, bukan palsu. */
export async function aiReachable(): Promise<boolean> {
  if (aiCache && Date.now() - aiCache.at < 60_000) return aiCache.ok;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  let ok = false;
  try {
    const res = await fetch(
      "https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=maGuAc",
      {
        method: "POST",
        signal: ctrl.signal,
        headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", "user-agent": UA },
        body: "f.req=%5B%5B%5B%22maGuAc%22%2C%22%5B0%5D%22%2Cnull%2C%22generic%22%5D%5D%5D&",
      }
    );
    const cookies = res.headers.getSetCookie?.() || [];
    ok = Boolean((cookies[0] || "").split("; ")[0]);
  } catch {
    ok = false;
  } finally {
    clearTimeout(timer);
    aiCache = { ok, at: Date.now() };
  }
  return ok;
}

export async function snapshot(): Promise<{
  db: DbStatus;
  maintenance: string;
  ai: boolean;
  flags: FeatureFlags;
}> {
  const [db, state, ai, flags] = await Promise.all([
    dbStatus(),
    getMaintenanceState(),
    aiReachable(),
    getFlags(),
  ]);
  return {
    db,
    maintenance: state.mode === "off" ? "OFF" : state.mode === "on" ? "ON" : "TERJADWAL",
    ai,
    flags,
  };
}

// ---------------- Export ----------------

export async function buildExport(): Promise<{ json: string; usersIncluded: number }> {
  const [state, cfg, ann, flags, stats] = await Promise.all([
    getMaintenanceState(),
    (await import("./maintenance")).getMaintenanceConfig(),
    (await import("./announce")).getAnnouncement(),
    getFlags(),
    userStats(),
  ]);
  const idx = await userIndex();
  const emails = Object.entries(idx.emails || {}).slice(-500);
  const users: Array<Record<string, unknown>> = [];
  for (const [, id] of emails) {
    const u = await readUser(id);
    if (u) {
      users.push({
        id: u.id,
        username: u.username || null,
        // Email disamarkan di export — data cukup untuk audit, tanpa bocor besar.
        email: u.email ? u.email.replace(/^(.).*(@.*)$/, "$1***$2") : null,
        created_at: u.created_at || null,
        suspended: u.suspended === true,
      });
    }
  }
  const payload = {
    exported_at: new Date().toISOString(),
    maintenance: { state, config: cfg },
    announcement: ann,
    features: flags,
    stats: stats,
    users,
  };
  return { json: JSON.stringify(payload, null, 2), usersIncluded: users.length };
}

// ---------------- Security (akses tanpa izin) ----------------

export interface TelegramSecurity {
  unauthorized_count: number;
  last_attempt_at: string | null;
  last_id_masked: string | null;
}

export async function recordUnauthorized(telegramId: number): Promise<void> {
  try {
    const idStr = String(telegramId);
    const masked = idStr.length > 4 ? idStr.slice(0, 2) + "***" + idStr.slice(-2) : idStr;
    await updateJson<TelegramSecurity>(KEYS.telegramSecurity, "tg security", (current) => ({
      unauthorized_count: (current?.unauthorized_count || 0) + 1,
      last_attempt_at: new Date().toISOString(),
      last_id_masked: masked,
    }));
  } catch {
    /* tidak boleh menjatuhkan webhook */
  }
}

export async function telegramSecurity(): Promise<TelegramSecurity> {
  const file = await readJson<TelegramSecurity>(KEYS.telegramSecurity).catch(() => null);
  return (
    file?.data || { unauthorized_count: 0, last_attempt_at: null, last_id_masked: null }
  );
}
