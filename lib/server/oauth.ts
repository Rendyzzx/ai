/* ============================================================
   Aomi — lib/server/oauth.ts
   Helper bersama untuk provider OAuth (Google/Discord)
   + account linking yang aman. Telegram punya modul sendiri
   (lib/server/telegram-auth.ts) karena flow-nya OTP, bukan OAuth.

   Prinsip:
   - Secret hanya di server, tidak pernah dikirim ke browser.
   - State & PKCE via cookie HttpOnly (CSRF).
   - Link mode (dari Pengaturan) dicegah takeover: cookie link
     HARUS signed HMAC + berasal dari session yang valid saat
     flow dimulai.
   - Email hanya dipercaya untuk auto-link jika provider menyatakan
     email terverifikasi. Email dari client tidak pernah dipakai
     sebagai identitas.
   ============================================================ */

import crypto from "node:crypto";
import { readJson, updateJson, putJson } from "./store";

export type ProviderId = "google" | "discord" | "telegram";

export interface UserIndex {
  emails?: Record<string, string>;
  usernames?: Record<string, string>;
  google_ids?: Record<string, string>;
  discord_ids?: Record<string, string>;
  telegram_ids?: Record<string, string>;
}

export interface UserRecord {
  id: string;
  username: string;
  email: string | null;
  password_hash?: string;
  google_id?: string;
  discord_id?: string;
  telegram_id?: number;
  avatar_url?: string;
  provider?: string;
  created_at: string;
}

/** Provider aktif berdasar env (UI menampilkan yang aktif saja). */
export function enabledProviders(): Record<ProviderId, boolean> {
  return {
    google: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    discord: Boolean(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET),
    telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_WEBHOOK_SECRET),
  };
}

// ---------------- Cookie helpers ----------------

export function getCookie(headers: Headers, name: string): string | null {
  const raw = headers.get("cookie") || "";
  for (const pair of raw.split(";")) {
    const [k, ...v] = pair.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function oauthSecret(): string {
  const s = process.env.SESSION_SECRET || process.env.GITHUB_TOKEN;
  if (!s) throw new Error("SESSION_SECRET / GITHUB_TOKEN belum diset");
  return s;
}

/** Tandatangani nilai cookie link mode: "<userId>.<hmac>". */
export function signLinkValue(userId: string): string {
  const mac = crypto.createHmac("sha256", oauthSecret()).update(`link:${userId}`).digest("base64url");
  return `${userId}.${mac}`;
}

export function verifyLinkValue(value: string | null): string | null {
  if (!value) return null;
  const idx = value.lastIndexOf(".");
  if (idx <= 0) return null;
  const userId = value.slice(0, idx);
  const expect = signLinkValue(userId);
  // timing-safe
  if (expect.length !== value.length || !crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(value))) {
    return null;
  }
  return userId;
}

/** Redirect ke /auth dengan param aman (whitelist value). */
export function redirectToAuth(params: Record<string, string>, clearCookies?: string[]): Response {
  const qs = new URLSearchParams(params).toString();
  const headers = new Headers({
    Location: `/auth?${qs}`,
    "Cache-Control": "no-store",
  });
  if (clearCookies?.length) {
    headers.set(
      "Set-Cookie",
      clearCookies
        .map((c) => `${c}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`)
        .join(", ")
    );
  }
  return new Response(null, { status: 302, headers });
}

/** Redirect sukses login: /auth?sid=... (sid disimpan client ke sessionStorage). */
export function redirectToAuthWithSession(sid: string, clearCookies?: string[]): Response {
  return redirectToAuth({ sid }, clearCookies);
}

/** Redirect sukses link (dari Pengaturan): kembali ke halaman settings. */
export function redirectToSettings(provider: string, clearCookies?: string[]): Response {
  const qs = new URLSearchParams({ linked: provider }).toString();
  const headers = new Headers({
    Location: `/?${qs}#pengaturan`,
    "Cache-Control": "no-store",
  });
  if (clearCookies?.length) {
    headers.set(
      "Set-Cookie",
      clearCookies
        .map((c) => `${c}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`)
        .join(", ")
    );
  }
  return new Response(null, { status: 302, headers });
}

// ---------------- Username & user helpers ----------------

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

/** Generate username unik dari nama provider (alfanumerik + underscore). */
export async function generateUniqueUsername(base: string): Promise<string> {
  let clean = base
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 20);
  if (clean.length < 3) clean = (clean + "user").slice(0, 20);

  const index = await readJson<UserIndex>("users/_index.json");
  const usernames = index?.data?.usernames || {};

  let candidate = clean;
  let suffix = 0;
  while (usernames[candidate]) {
    suffix++;
    const s = String(suffix);
    candidate = clean.slice(0, 20 - s.length) + s;
  }
  return candidate;
}

/** Kunci index untuk tiap provider. */
function providerIndexKey(provider: ProviderId): keyof UserIndex {
  switch (provider) {
    case "google": return "google_ids";
    case "discord": return "discord_ids";
    case "telegram": return "telegram_ids";
  }
}

/** Cari user id lewat index provider. */
export async function findUserByProvider(
  provider: ProviderId,
  providerUserId: string | number
): Promise<string | null> {
  const key = providerIndexKey(provider);
  const index = await readJson<UserIndex>("users/_index.json");
  const map = (index?.data?.[key] || {}) as Record<string, string>;
  return map[String(providerUserId)] || null;
}

/** Cari user id lewat email (hanya dipakai bila email terverifikasi provider). */
export async function findUserByEmail(email: string): Promise<string | null> {
  const index = await readJson<UserIndex>("users/_index.json");
  return index?.data?.emails?.[email.toLowerCase()] || null;
}

/**
 * Tautkan provider ke user yang SUDAH ADA (account linking).
 * Dipanggil: (a) auto-link email terverifikasi saat login, atau
 * (b) link mode dari Pengaturan (user sudah login & memilih sendiri).
 */
export async function linkProviderToUser(
  userId: string,
  provider: ProviderId,
  providerUserId: string | number,
  extra?: Partial<UserRecord>
): Promise<boolean> {
  const key = providerIndexKey(provider);
  const updated = await updateJson<UserRecord>(
    `users/${userId}.json`,
    `${provider} link`,
    (current) => {
      if (!current) return undefined;
      const next: UserRecord = { ...current };
      if (provider === "google") next.google_id = String(providerUserId);
      if (provider === "discord") next.discord_id = String(providerUserId);
      if (provider === "telegram") next.telegram_id = Number(providerUserId);
      if (extra?.avatar_url && !current.avatar_url) next.avatar_url = extra.avatar_url;
      return next;
    }
  );
  if (!updated) return false;

  await updateJson<UserIndex>("users/_index.json", `${provider} link index`, (current) => {
    const data = current || {};
    const map = (data[key] = data[key] || {}) as Record<string, string>;
    map[String(providerUserId)] = userId;
    return data;
  });
  return true;
}

/** Buat user baru dari provider (belum ada email yang cocok). */
export async function createProviderUser(
  provider: ProviderId,
  providerUserId: string | number,
  usernameBase: string,
  email: string | null, // null bila tidak terverifikasi / tidak tersedia
  extra?: Partial<UserRecord>
): Promise<string> {
  const username = await generateUniqueUsername(usernameBase);
  const userId = crypto.randomUUID();
  const user: UserRecord = {
    id: userId,
    username,
    email, // null = tidak bisa dipakai login manual; identitas via provider
    provider,
    created_at: new Date().toISOString(),
    ...extra,
  };
  if (provider === "google") user.google_id = String(providerUserId);
  if (provider === "discord") user.discord_id = String(providerUserId);
  if (provider === "telegram") user.telegram_id = Number(providerUserId);

  await putJson(`users/${userId}.json`, user, `${provider} user create`);

  const key = providerIndexKey(provider);
  await updateJson<UserIndex>("users/_index.json", `${provider} user index`, (current) => {
    const data = current || {};
    const map = (data[key] = data[key] || {}) as Record<string, string>;
    map[String(providerUserId)] = userId;
    if (email) {
      // Email terverifikasi → boleh masuk index (bisa dipakai login manual nanti).
      data.emails = data.emails || {};
      data.emails[email.toLowerCase()] = userId;
    }
    data.usernames = data.usernames || {};
    data.usernames[username.toLowerCase()] = userId;
    return data;
  });
  return userId;
}
