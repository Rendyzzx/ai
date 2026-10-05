/* ============================================================
   Aomi — lib/server/adminsvc.ts
   Service untuk menu admin Telegram: status database, user,
   monitoring, security, cleanup, export. Dipakai handler bot
   (bukan handler yang akses storage langsung).
   ============================================================ */

import crypto from "node:crypto";
import {
  listJsonPaths,
  readJson,
  putJson,
  updateJson,
  deleteJson,
  expireJson,
  deleteMany,
  redisCommand,
  scanPaths,
  USE_REDIS,
} from "./store";
import { listDirs } from "./github";
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

// ---------------- Reset User & Chat (wipe) ----------------

export interface WipePreview {
  /** Perkiraan jumlah user yang terhapus (index + folder chat). */
  users: number;
  /** Jumlah folder chat per user yang ditemukan. */
  chatFolders: number;
  /** Jumlah sesi login aktif. */
  sessions: number;
}

export interface WipeResult {
  users: number;
  chats: number;
  bots: number;
  sessions: number;
  locks: number;
  tempimg: number;
}

/** Daftar folder chat (uid) — Redis SCAN / GitHub dir list. */
async function listChatDirs(): Promise<string[]> {
  const scanned = await scanPaths("chats/*").catch(() => null as string[] | null);
  if (scanned !== null) {
    const dirs = new Set<string>();
    for (const p of scanned) {
      const parts = p.split("/"); // chats/<uid>/<file>.json
      if (parts.length >= 3 && parts[2]) dirs.add(parts[2]);
    }
    return [...dirs];
  }
  return listDirs("chats").catch(() => [] as string[]);
}

/** Semua file akun user (users/*.json) KECUALI index & daftar suspend
 *  — enumerasi langsung dari folder, jadi user orphan yang tidak ada
 *  di index pun ikut terhapus. */
async function userAccountFiles(): Promise<string[]> {
  const files = await listJsonPaths("users").catch(() => [] as string[]);
  return files.filter((p) => !p.endsWith("/_index.json") && !p.endsWith("/suspended.json"));
}

/** Ringkasan jumlah data yang AKAN dihapus (untuk konfirmasi). */
export async function wipePreview(): Promise<WipePreview> {
  const [accounts, chatDirs, sessions] = await Promise.all([
    userAccountFiles(),
    listChatDirs(),
    listJsonPaths("sessions").catch(() => [] as string[]),
  ]);
  return { users: accounts.length, chatFolders: chatDirs.length, sessions: sessions.length };
}

/**
 * Hapus SEMUA data user & chat sekaligus: akun + profil, riwayat chat,
 * konfigurasi karakter, sesi login, lock login, gambar sementara.
 * Index user & daftar suspend DIKOSONGKAN (bukan dihapus) supaya
 * alur register/login tetap sehat. Config situs, asset, audit log,
 * dan state bot TIDAK disentuh. Tidak bisa diurungkan.
 */
export async function wipeUserData(): Promise<WipeResult> {
  const chatDirs = await listChatDirs();
  const targets: string[] = [];
  const result: WipeResult = { users: 0, chats: 0, bots: 0, sessions: 0, locks: 0, tempimg: 0 };

  // Akun + profil user — langsung dari folder users/
  const accounts = await userAccountFiles();
  result.users = accounts.length;
  targets.push(...accounts);

  // Riwayat chat per user (semua folder chat, termasuk orphan)
  for (const uid of chatDirs) {
    const files = await listJsonPaths(`chats/${uid}`).catch(() => [] as string[]);
    result.chats += files.length;
    targets.push(...files);
  }

  // Konfigurasi karakter per user (semua file bots/)
  const bots = await listJsonPaths("bots").catch(() => [] as string[]);
  result.bots = bots.length;
  targets.push(...bots);

  // Sesi login, lock brute force, gambar sementara
  for (const [dir, field] of [
    ["sessions", "sessions"],
    ["locks", "locks"],
    ["tempimg", "tempimg"],
  ] as const) {
    const files = await listJsonPaths(dir).catch(() => [] as string[]);
    result[field] = files.length;
    targets.push(...files);
  }

  await deleteMany(targets);

  // Index user & daftar suspend dikosongkan kembali (bukan dihapus)
  await putJson("users/_index.json", { emails: {}, usernames: {} }, "wipe: user index reset");
  await putJson(KEYS.suspendedUsers, { ids: [] }, "wipe: suspended reset");
  resetSuspendedCache();

  return result;
}

// ---------------- Permintaan wipe (persetujuan OWNER) ----------------

export interface WipeRequest {
  id: string;
  requested_by_id: number;
  requested_by_role: string;
  created_at: string;
}

export const WIPE_REQUEST_TTL_MS = 15 * 60 * 1000;

/** Buat permintaan wipe (menunggu persetujuan OWNER). TTL 15 menit. */
export async function createWipeRequest(by: { id: number; role: string }): Promise<WipeRequest> {
  const req: WipeRequest = {
    id: crypto.randomBytes(6).toString("hex"),
    requested_by_id: by.id,
    requested_by_role: by.role,
    created_at: new Date().toISOString(),
  };
  await putJson(KEYS.dbWipeRequest, req, "wipe request create");
  await expireJson(KEYS.dbWipeRequest, WIPE_REQUEST_TTL_MS / 1000).catch(() => {});
  return req;
}

/**
 * Ambil permintaan wipe by id — sekaligus HAPUS (dikonsumsi sekali,
 * klik Setujui/Tolak dua kali tidak menjalankan aksi dua kali).
 * "gone" = tidak ada / sudah diproses; "expired" = lewat TTL.
 */
export async function takeWipeRequest(
  id: string
): Promise<{ status: "ok"; req: WipeRequest } | { status: "gone" | "expired" }> {
  const file = await readJson<WipeRequest>(KEYS.dbWipeRequest).catch(() => null);
  const req = file?.data;
  if (!req || req.id !== id) return { status: "gone" };
  if (Date.now() - Date.parse(req.created_at) > WIPE_REQUEST_TTL_MS) {
    await deleteJson(KEYS.dbWipeRequest).catch(() => {});
    return { status: "expired" };
  }
  await deleteJson(KEYS.dbWipeRequest).catch(() => {});
  return { status: "ok", req };
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
