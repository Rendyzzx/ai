// ============================================================
// GET /api/auth/google
// Memulai Google OAuth 2.0 (Authorization Code + PKCE).
// State + code_verifier disimpan di httpOnly cookie untuk CSRF & PKCE.
// Redirect ke Google consent screen.
// ============================================================

import crypto from "node:crypto";
import { json, methodNotAllowed } from "@/lib/server/http";

export const dynamic = "force-dynamic";

const SCOPES = ["openid", "email", "profile"].join(" ");

function getRedirectUri(req: Request): string {
  // Override via env (untuk kasus khusus, mis. proxy domain berbeda)
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;

  // Auto-detect dari request
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
  return `${proto}://${host}/api/auth/google/callback`;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export async function GET(req: Request) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return json({ error: "Google OAuth belum dikonfigurasi." }, 500);
  }

  const redirectUri = getRedirectUri(req);
  const state = base64url(crypto.randomBytes(32));
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(
    crypto.createHash("sha256").update(codeVerifier).digest()
  );

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    // prompt=select_account supaya user bisa pilih akun Google
    prompt: "select_account",
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;

  const res = new Response(null, {
    status: 302,
    headers: {
      Location: authUrl,
      "Set-Cookie": [
        `oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`,
        `oauth_verifier=${codeVerifier}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`,
      ].join(", "),
      "Cache-Control": "no-store",
    },
  });

  return res;
}

export async function POST() {
  return methodNotAllowed("GET");
}
