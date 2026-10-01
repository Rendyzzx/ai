// ============================================================
// Aomi — api/lib/auth.js
// Utilitas otentikasi: password scrypt, session cookie HttpOnly,
// verifikasi manusia (soal matematika terenkripsi), lock login.
// Semua tanpa dependency eksternal (crypto bawaan Node).
// ============================================================

import crypto from 'node:crypto';
import { readJson, putJson, deleteJson } from './github.js';

export const SESSION_COOKIE = 'aomi_session';

export const SESSION_SHORT_MS = 12 * 3600 * 1000;  // 12 jam
export const SESSION_LONG_MS = 30 * 24 * 3600 * 1000; // 30 hari (remember me)
const ACTIVITY_REFRESH_MS = 6 * 3600 * 1000;   // update last_activity max 1x/6 jam

// ---------------- Secret (env Vercel) ----------------

function secret() {
  // SESSION_SECRET disarankan; fallback ke GITHUB_TOKEN agar tetap jalan.
  const s = process.env.SESSION_SECRET || process.env.GITHUB_TOKEN;
  if (!s) throw new Error('SESSION_SECRET / GITHUB_TOKEN belum diset');
  return s;
}

const encKey = () => crypto.createHash('sha256').update(secret() + ':enc').digest();

// ---------------- Password (scrypt + timing-safe) ----------------

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, salt, hash] = String(stored || '').split(':');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const test = crypto.scryptSync(password, salt, 64);
    return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
  } catch {
    return false;
  }
}

// ---------------- Session ----------------

export function newSessionId() {
  return crypto.randomBytes(32).toString('hex'); // token acak 256-bit
}

export async function createSession(userId, remember) {
  const now = Date.now();
  const session = {
    session_id: newSessionId(),
    user_id: userId,
    remember: Boolean(remember),
    last_activity: now,
    expires_at: now + (remember ? SESSION_LONG_MS : SESSION_SHORT_MS)
  };
  await putJson(`sessions/${session.session_id}.json`, session, 'session create');
  return session;
}

export function sessionCookie(sid, remember, maxAgeMs) {
  const base = `${SESSION_COOKIE}=${sid}; HttpOnly; Secure; SameSite=Lax; Path=/`;
  return maxAgeMs ? `${base}; Max-Age=${Math.floor(maxAgeMs / 1000)}` : base;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/**
 * Validasi sesi dari cookie. Return session | null.
 * last_activity diperbarui ke repo maksimal 1x per 6 jam (hemat penulisan).
 */
export async function getSession(req) {
  const cookies = parseCookies(req.headers?.cookie);
  const sid = cookies[SESSION_COOKIE];
  if (!sid || !/^[a-f0-9]{64}$/.test(sid)) return null;

  const file = await readJson(`sessions/${sid}.json`);
  if (!file) return null;
  const s = file.data;
  const now = Date.now();

  if (typeof s.expires_at !== 'number' || s.expires_at < now) {
    await deleteJson(`sessions/${sid}.json`).catch(() => {});
    return null;
  }

  // perpanjang sesi aktif + catat aktivitas (lazy)
  if (now - (s.last_activity || 0) > ACTIVITY_REFRESH_MS) {
    s.last_activity = now;
    s.expires_at = now + (s.remember ? SESSION_LONG_MS : SESSION_SHORT_MS);
    await putJson(`sessions/${sid}.json`, s, 'session refresh').catch(() => {});
  }
  return s;
}

export async function destroySession(req) {
  const cookies = parseCookies(req.headers?.cookie);
  const sid = cookies[SESSION_COOKIE];
  if (sid && /^[a-f0-9]{64}$/.test(sid)) {
    await deleteJson(`sessions/${sid}.json`).catch(() => {});
  }
}

// ---------------- Verifikasi manusia (tanpa layanan pihak ketiga) ----------------
// Soal matematika acak; jawaban dikirim ke browser dalam bentuk
// TERENKRIPSI (AES-256-GCM) → bot tidak bisa membaca jawabannya
// sekalipun membedah token. Berlaku 5 menit.

const CAPTCHA_TTL_MS = 5 * 60 * 1000;

function encryptJSON(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const payload = Buffer.concat([cipher.update(JSON.stringify(obj)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, payload]).toString('base64');
}

function decryptJSON(token) {
  const raw = Buffer.from(String(token), 'base64');
  if (raw.length < 29) return null;
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const payload = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey(), iv);
  decipher.setAuthTag(tag);
  try {
    return JSON.parse(Buffer.concat([decipher.update(payload), decipher.final()]).toString());
  } catch {
    return null;
  }
}

export function makeCaptcha() {
  const ops = ['+', '-', '×'];
  const op = ops[crypto.randomInt(0, ops.length)];
  let a, b;
  switch (op) {
    case '+': a = crypto.randomInt(2, 50); b = crypto.randomInt(2, 49); break;
    case '-': a = crypto.randomInt(10, 99); b = crypto.randomInt(2, 9); break;
    default:  a = crypto.randomInt(2, 9);  b = crypto.randomInt(2, 9);
  }
  const answer = op === '+' ? a + b : op === '-' ? a - b : a * b;
  return {
    question: `Berapa ${a} ${op} ${b}?`,
    token: encryptJSON({ a: answer, exp: Date.now() + CAPTCHA_TTL_MS })
  };
}

export function verifyCaptcha(token, answer) {
  const data = decryptJSON(token);
  if (!data) return false;
  if (typeof data.a !== 'number' || Date.now() > data.exp) return false;
  const guess = Number(String(answer).trim());
  if (!Number.isFinite(guess)) return false;
  return crypto.timingSafeEqual(
    Buffer.from(String(guess)),
    Buffer.from(String(data.a))
  );
}

// ---------------- Lock brute force (persist di repo) ----------------

const LOCK_MAX_FAILS = 5;
const LOCK_WINDOW_MS = 15 * 60 * 1000;  // hitung 15 menit
const LOCK_PENALTY_MS = 15 * 60 * 1000; // terkunci 15 menit

export async function lockKey(identifier, ip) {
  return 'login-' + crypto.createHash('sha256')
    .update(`${identifier}|${ip}`).digest('hex').slice(0, 32) + '.json';
}

export async function getLoginLock(identifier, ip) {
  const file = await readJson(`locks/${await lockKey(identifier, ip)}`);
  if (!file) return null;
  return file.data.locked_until > Date.now() ? file.data : null;
}

export async function recordLoginFail(identifier, ip) {
  const path = `locks/${await lockKey(identifier, ip)}`;
  const file = await readJson(path);
  const now = Date.now();
  const fails = (file?.data?.fails || []).filter((t) => now - t < LOCK_WINDOW_MS);
  fails.push(now);
  const locked = fails.length >= LOCK_MAX_FAILS;
  const data = {
    fails: locked ? [] : fails,
    locked_until: locked ? now + LOCK_PENALTY_MS : 0
  };
  await putJson(path, data, 'login fail');
  return locked;
}

export async function clearLoginLock(identifier, ip) {
  await deleteJson(`locks/${await lockKey(identifier, ip)}`).catch(() => {});
}

// ---------------- Validasi field ----------------

export function validateCredentials(username, email, password) {
  const errors = [];
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username || '')) {
    errors.push('Username 3-20 karakter, hanya huruf, angka, dan underscore.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || '').toLowerCase())) {
    errors.push('Format email tidak valid.');
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 72) {
    errors.push('Password minimal 8 karakter.');
  }
  return errors;
}
