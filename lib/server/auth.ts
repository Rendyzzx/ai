/* ============================================================
   Aomi — lib/server/auth.ts
   Port dari lib/auth.js: password scrypt, session id opaque via
   header, captcha terenkripsi AES-256-GCM, lock brute force.
   Tanpa dependency eksternal (crypto bawaan Node).
   ============================================================ */

import crypto from "node:crypto";
import { readJson, putJson, deleteJson, expireJson } from "./store";
import { APP_VERSION } from "./version";

export const SESSION_SHORT_MS = 12 * 3600 * 1000; // 12 jam
export const SESSION_LONG_MS = 30 * 24 * 3600 * 1000; // 30 hari (remember me)
const ACTIVITY_REFRESH_MS = 6 * 3600 * 1000; // refresh last_activity max 1x/6 jam

export interface Session {
  session_id: string;
  user_id: string;
  remember: boolean;
  app_version: string;
  last_activity: number;
  expires_at: number;
}

/** Session id dari header (X-Session-Id atau Authorization Bearer). */
export function getSessionId(headers: Headers): string | null {
  const raw =
    headers.get("x-session-id") ||
    (String(headers.get("authorization") || "").replace(/^Bearer\s+/i, "") || "");
  const sid = String(raw).trim();
  return /^[a-f0-9]{64}$/.test(sid) ? sid : null;
}

// ---------------- Secret (env) ----------------

function secret(): string {
  const s = process.env.SESSION_SECRET || process.env.GITHUB_TOKEN;
  if (!s) throw new Error("SESSION_SECRET / GITHUB_TOKEN belum diset");
  return s;
}

const encKey = () => crypto.createHash("sha256").update(secret() + ":enc").digest();

// ---------------- Password (scrypt + timing-safe) ----------------

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string | undefined): boolean {
  try {
    const [scheme, salt, hash] = String(stored || "").split(":");
    if (scheme !== "scrypt" || !salt || !hash) return false;
    const test = crypto.scryptSync(password, salt, 64);
    return crypto.timingSafeEqual(test, Buffer.from(hash, "hex"));
  } catch {
    return false;
  }
}

// ---------------- Session ----------------

export function newSessionId(): string {
  return crypto.randomBytes(32).toString("hex"); // token acak 256-bit
}

export async function createSession(
  userId: string,
  remember: boolean
): Promise<Session> {
  const now = Date.now();
  const session: Session = {
    session_id: newSessionId(),
    user_id: userId,
    remember: Boolean(remember),
    app_version: APP_VERSION,
    last_activity: now,
    expires_at: now + (remember ? SESSION_LONG_MS : SESSION_SHORT_MS),
  };
  const path = `sessions/${session.session_id}.json`;

  // putJson mengembalikan false saat GitHub menolak tulis (race 409/422) → gagal keras.
  const written = await putJson(path, session, "session create");
  if (written === false) {
    throw new Error("session write ditolak github");
  }

  // Read-back verification sebelum login menjawab sukses.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 300 * attempt));
    try {
      const file = await readJson<Session>(path);
      if (file) {
        // Redis mode: TTL otomatis; GitHub mode: no-op.
        await expireJson(path, (session.expires_at - now) / 1000);
        return session;
      }
    } catch {
      /* storage error sesaat → coba lagi */
    }
  }
  throw new Error("session tidak terbaca setelah ditulis");
}

/** Validasi sesi dari header. Return session | null. */
export async function getSession(headers: Headers): Promise<Session | null> {
  const sid = getSessionId(headers);
  if (!sid) return null;

  const file = await readJson<Session>(`sessions/${sid}.json`);
  if (!file) return null;
  const s = file.data;
  const now = Date.now();

  if (typeof s.expires_at !== "number" || s.expires_at < now) {
    await deleteJson(`sessions/${sid}.json`).catch(() => {});
    return null;
  }

  // Deployment baru (APP_VERSION naik) → session versi lama hancur.
  if (s.app_version !== APP_VERSION) {
    await deleteJson(`sessions/${sid}.json`).catch(() => {});
    return null;
  }

  // perpanjang sesi aktif + catat aktivitas (lazy, max 1x/6 jam)
  if (now - (s.last_activity || 0) > ACTIVITY_REFRESH_MS) {
    s.last_activity = now;
    s.expires_at = now + (s.remember ? SESSION_LONG_MS : SESSION_SHORT_MS);
    await putJson(`sessions/${sid}.json`, s, "session refresh").catch(() => {});
    await expireJson(`sessions/${sid}.json`, (s.expires_at - now) / 1000).catch(() => {});
  }
  return s;
}

export async function destroySession(headers: Headers): Promise<void> {
  const sid = getSessionId(headers);
  if (sid) {
    await deleteJson(`sessions/${sid}.json`).catch(() => {});
  }
}

// ---------------- Verifikasi manusia (captcha terenkripsi) ----------------

const CAPTCHA_TTL_MS = 5 * 60 * 1000;

function encryptJSON(obj: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encKey(), iv);
  const payload = Buffer.concat([cipher.update(JSON.stringify(obj)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, payload]).toString("base64");
}

function decryptJSON(token: string): { a: number; exp: number } | null {
  const raw = Buffer.from(String(token), "base64");
  if (raw.length < 29) return null;
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const payload = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", encKey(), iv);
  decipher.setAuthTag(tag);
  try {
    return JSON.parse(
      Buffer.concat([decipher.update(payload), decipher.final()]).toString()
    );
  } catch {
    return null;
  }
}

export function makeCaptcha(): { number: string; token: string } {
  // Angka acak 4 digit: ditampilkan ke user, jawaban tetap terenkripsi.
  const number = String(crypto.randomInt(1000, 10000));
  return {
    number,
    token: encryptJSON({ a: Number(number), exp: Date.now() + CAPTCHA_TTL_MS }),
  };
}

export function verifyCaptcha(token: unknown, answer: unknown): boolean {
  const data = decryptJSON(String(token || ""));
  if (!data) return false;
  if (typeof data.a !== "number" || Date.now() > data.exp) return false;
  const guess = Number(String(answer).trim());
  if (!Number.isFinite(guess)) return false;
  const a = Buffer.alloc(8);
  const b = Buffer.alloc(8);
  a.writeBigUInt64BE(BigInt(guess));
  b.writeBigUInt64BE(BigInt(data.a));
  return crypto.timingSafeEqual(a, b);
}

// ---------------- Lock brute force (persist di storage) ----------------

const LOCK_MAX_FAILS = 5;
const LOCK_WINDOW_MS = 15 * 60 * 1000;
const LOCK_PENALTY_MS = 15 * 60 * 1000;

export interface LoginLock {
  fails: number[];
  locked_until: number;
}

async function lockKey(identifier: string, ip: string): Promise<string> {
  return (
    "login-" +
    crypto
      .createHash("sha256")
      .update(`${identifier}|${ip}`)
      .digest("hex")
      .slice(0, 32) +
    ".json"
  );
}

export async function getLoginLock(
  identifier: string,
  ip: string
): Promise<LoginLock | null> {
  const file = await readJson<LoginLock>(`locks/${await lockKey(identifier, ip)}`);
  if (!file) return null;
  return file.data.locked_until > Date.now() ? file.data : null;
}

export async function recordLoginFail(identifier: string, ip: string): Promise<boolean> {
  const path = `locks/${await lockKey(identifier, ip)}`;
  const file = await readJson<LoginLock>(path);
  const now = Date.now();
  const fails = (file?.data?.fails || []).filter((t) => now - t < LOCK_WINDOW_MS);
  fails.push(now);
  const locked = fails.length >= LOCK_MAX_FAILS;
  const data: LoginLock = {
    fails: locked ? [] : fails,
    locked_until: locked ? now + LOCK_PENALTY_MS : 0,
  };
  await putJson(path, data, "login fail");
  return locked;
}

export async function clearLoginLock(identifier: string, ip: string): Promise<void> {
  await deleteJson(`locks/${await lockKey(identifier, ip)}`).catch(() => {});
}

// ---------------- Validasi field ----------------

export function validateCredentials(
  username: string,
  email: string,
  password: unknown
): string[] {
  const errors: string[] = [];
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username || "")) {
    errors.push("Username 3-20 karakter, hanya huruf, angka, dan underscore.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || "").toLowerCase())) {
    errors.push("Format email tidak valid.");
  }
  if (typeof password !== "string" || password.length < 8 || password.length > 128) {
    errors.push("Password minimal 8 karakter.");
  }
  return errors;
}
