// ============================================================
// GET /api/auth/google/callback
// Callback Google OAuth: verify state + PKCE, tukar code → token,
// ambil userinfo, cari/buat user, buat session.
// Redirect ke /auth?sid=... (sukses) atau /auth?error=... (gagal).
// ============================================================

import crypto from "node:crypto";
import { readJson, putJson, updateJson } from "@/lib/server/store";
import { createSession } from "@/lib/server/auth";
import { json, methodNotAllowed } from "@/lib/server/http";

export const dynamic = "force-dynamic";

interface GoogleUserinfo {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  given_name?: string;
  family_name?: string;
}

interface UserRecord {
  id: string;
  username: string;
  email: string;
  password_hash?: string;
  google_id?: string;
  avatar_url?: string;
  provider?: string;
  created_at: string;
}

interface UserIndex {
  emails?: Record<string, string>;
  usernames?: Record<string, string>;
  google_ids?: Record<string, string>;
}

/** Baca cookie dari header Cookie. */
function getCookie(headers: Headers, name: string): string | null {
  const raw = headers.get("cookie") || "";
  for (const pair of raw.split(";")) {
    const [k, ...v] = pair.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function getRedirectUri(req: Request): string {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
  return `${proto}://${host}/api/auth/google/callback`;
}

function redirectToAuth(params: Record<string, string>): Response {
  const qs = new URLSearchParams(params).toString();
  const res = new Response(null, {
    status: 302,
    headers: {
      Location: `/auth?${qs}`,
      // Hapus cookie OAuth setelah dipakai
      "Set-Cookie": [
        "oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
        "oauth_verifier=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
      ].join(", "),
      "Cache-Control": "no-store",
    },
  });
  return res;
}

/** Tukar authorization code → access token + id_token. */
async function exchangeCode(
  code: string,
  codeVerifier: string,
  redirectUri: string
): Promise<{ access_token: string; id_token: string } | null> {
  const body = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID!,
    client_secret: process.env.GOOGLE_CLIENT_SECRET!,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    code_verifier: codeVerifier,
  });

  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return { access_token: data.access_token, id_token: data.id_token };
  } catch {
    return null;
  }
}

/** Ambil userinfo dari Google. */
async function getUserinfo(accessToken: string): Promise<GoogleUserinfo | null> {
  try {
    const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as GoogleUserinfo;
  } catch {
    return null;
  }
}

/** Generate username unik dari nama/email Google. */
async function generateUsername(
  base: string,
  index: UserIndex
): Promise<string> {
  // Bersihkan: hanya alfanumerik & underscore, max 20
  let clean = base
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 20);
  if (clean.length < 3) clean = (clean + "user").slice(0, 20);

  // Jika sudah dipakai, tambahkan suffix angka
  let candidate = clean;
  let suffix = 0;
  const usernames = index.usernames || {};
  while (usernames[candidate]) {
    suffix++;
    const s = String(suffix);
    candidate = clean.slice(0, 20 - s.length) + s;
  }
  return candidate;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  // User membatalkan login Google
  if (errorParam === "access_denied") {
    return redirectToAuth({ error: "google_cancelled" });
  }
  if (errorParam) {
    return redirectToAuth({ error: "google_error" });
  }

  if (!code || !state) {
    return redirectToAuth({ error: "google_invalid_callback" });
  }

  // Verifikasi state (CSRF protection)
  const cookieState = getCookie(req.headers, "oauth_state");
  const codeVerifier = getCookie(req.headers, "oauth_verifier");

  if (!cookieState || cookieState !== state) {
    return redirectToAuth({ error: "google_state_mismatch" });
  }
  if (!codeVerifier) {
    return redirectToAuth({ error: "google_state_mismatch" });
  }

  // Tukar code → token
  const redirectUri = getRedirectUri(req);
  const tokens = await exchangeCode(code, codeVerifier, redirectUri);
  if (!tokens) {
    return redirectToAuth({ error: "google_token_failed" });
  }

  // Ambil userinfo
  const userInfo = await getUserinfo(tokens.access_token);
  if (!userInfo || !userInfo.email) {
    return redirectToAuth({ error: "google_userinfo_failed" });
  }

  // Google harus mengkonfirmasi email terverifikasi
  if (userInfo.email_verified === false) {
    return redirectToAuth({ error: "google_email_not_verified" });
  }

  const googleId = userInfo.sub;
  const email = userInfo.email.toLowerCase();

  // Cari user berdasarkan google_id di index
  const indexFile = await readJson<UserIndex>("users/_index.json");
  const idx = indexFile?.data || { emails: {}, usernames: {}, google_ids: {} };
  idx.emails = idx.emails || {};
  idx.usernames = idx.usernames || {};
  idx.google_ids = idx.google_ids || {};

  let userId = idx.google_ids?.[googleId];

  // Tidak ada via google_id → cek via email (account linking)
  if (!userId) {
    userId = idx.emails?.[email];
    if (userId) {
    // User sudah ada dengan email yang sama → link Google account
      await updateJson<UserRecord>(
        `users/${userId}.json`,
        "google link",
        (current) => {
          if (!current) return undefined;
          return {
            ...current,
            google_id: googleId,
            avatar_url: userInfo.picture || current.avatar_url,
          };
        }
      );
      // Update index
      await updateJson<UserIndex>(
        "users/_index.json",
        "google link index",
        (current) => {
          const data = current || { emails: {}, usernames: {}, google_ids: {} };
          data.google_ids = data.google_ids || {};
          data.google_ids[googleId] = userId!;
          return data;
        }
      );
    }
  }

  // Tidak ada user sama sekali → buat user baru
  if (!userId) {
    userId = crypto.randomUUID();
    const baseName = userInfo.given_name || userInfo.name || email.split("@")[0];
    const username = await generateUsername(baseName, idx);

    const newUser: UserRecord = {
      id: userId,
      username,
      email,
      google_id: googleId,
      avatar_url: userInfo.picture || undefined,
      provider: "google",
      created_at: new Date().toISOString(),
    };

    await putJson(`users/${userId}.json`, newUser, "google user create");

    // Update index
    await updateJson<UserIndex>(
      "users/_index.json",
      "google user index",
      (current) => {
        const data = current || { emails: {}, usernames: {}, google_ids: {} };
        data.emails = data.emails || {};
        data.usernames = data.usernames || {};
        data.google_ids = data.google_ids || {};
        data.emails[email] = userId!;
        data.usernames[username.toLowerCase()] = userId!;
        data.google_ids[googleId] = userId!;
        return data;
      }
    );
  }

  // Ambil data user final
  const userFile = await readJson<UserRecord>(`users/${userId}.json`);
  if (!userFile) {
    return redirectToAuth({ error: "google_user_not_found" });
  }

  // Buat session (sama seperti login/register)
  let session;
  try {
    session = await createSession(userId, true);
  } catch {
    return redirectToAuth({ error: "google_session_failed" });
  }

  // Redirect ke /auth dengan session_id → client simpan di sessionStorage
  return redirectToAuth({ sid: session.session_id });
}

export async function POST() {
  return methodNotAllowed("GET");
}
