// ============================================================
// GET /api/auth/facebook/callback — tukar code → token → user.
// Facebook Login versi Graph v19.0. Email Facebook dianggap
// terverifikasi (kebijakan FB: email harus aktif), tapi bila
// tidak tersedia → akun dibuat dengan email null (identitas via
// Facebook user id saja, tidak pernah pakai klaim client).
// ============================================================

import { createSession } from "@/lib/server/auth";
import {
  getCookie,
  redirectToAuth,
  redirectToSettings,
  verifyLinkValue,
  findUserByProvider,
  findUserByEmail,
  linkProviderToUser,
  createProviderUser,
} from "@/lib/server/oauth";
import { methodNotAllowed } from "@/lib/server/http";

export const dynamic = "force-dynamic";

interface FbUser {
  id: string;
  name?: string;
  email?: string;
}

const CLEAR_COOKIES = ["fb_state", "fb_link"];

function getRedirectUri(req: Request): string {
  if (process.env.FACEBOOK_REDIRECT_URI) return process.env.FACEBOOK_REDIRECT_URI;
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
  return `${proto}://${host}/api/auth/facebook/callback`;
}

async function exchangeCode(code: string, redirectUri: string): Promise<string | null> {
  const params = new URLSearchParams({
    client_id: process.env.FACEBOOK_CLIENT_ID!,
    client_secret: process.env.FACEBOOK_CLIENT_SECRET!,
    redirect_uri: redirectUri,
    code,
  });
  try {
    const res = await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?${params}`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { access_token?: string };
    return data.access_token || null;
  } catch {
    return null;
  }
}

async function getFbUser(accessToken: string): Promise<FbUser | null> {
  try {
    const params = new URLSearchParams({
      fields: "id,name,email",
      access_token: accessToken,
    });
    const res = await fetch(`https://graph.facebook.com/v19.0/me?${params}`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as FbUser;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  if (errorParam === "access_denied") {
    return redirectToAuth({ error: "facebook_cancelled" }, CLEAR_COOKIES);
  }
  if (errorParam) {
    return redirectToAuth({ error: "facebook_error" }, CLEAR_COOKIES);
  }
  if (!code || !state) {
    return redirectToAuth({ error: "facebook_invalid_callback" }, CLEAR_COOKIES);
  }

  const cookieState = getCookie(req.headers, "fb_state");
  if (!cookieState || cookieState !== state) {
    return redirectToAuth({ error: "facebook_state_mismatch" }, CLEAR_COOKIES);
  }

  const accessToken = await exchangeCode(code, getRedirectUri(req));
  if (!accessToken) {
    return redirectToAuth({ error: "facebook_token_failed" }, CLEAR_COOKIES);
  }

  const user = await getFbUser(accessToken);
  if (!user || !user.id) {
    return redirectToAuth({ error: "facebook_userinfo_failed" }, CLEAR_COOKIES);
  }

  const fbId = user.id;
  const email = user.email ? user.email.toLowerCase() : null;

  // ---- Link mode (Pengaturan) ----
  const linkCookie = getCookie(req.headers, "fb_link");
  const linkUserId = verifyLinkValue(linkCookie);
  if (linkCookie) {
    if (!linkUserId) {
      return redirectToAuth({ error: "facebook_state_mismatch" }, CLEAR_COOKIES);
    }
    const owner = await findUserByProvider("facebook", fbId);
    if (owner && owner !== linkUserId) {
      return redirectToSettings("facebook_taken", CLEAR_COOKIES);
    }
    const ok = await linkProviderToUser(linkUserId, "facebook", fbId);
    if (!ok) {
      return redirectToSettings("facebook_failed", CLEAR_COOKIES);
    }
    return redirectToSettings("facebook", CLEAR_COOKIES);
  }

  // ---- Login mode ----
  let userId = await findUserByProvider("facebook", fbId);

  if (!userId && email) {
    userId = await findUserByEmail(email);
    if (userId) {
      await linkProviderToUser(userId, "facebook", fbId);
    }
  }

  if (!userId) {
    userId = await createProviderUser("facebook", fbId, user.name || "user", email);
  }

  try {
    const session = await createSession(userId, true);
    return redirectToAuth({ sid: session.session_id }, CLEAR_COOKIES);
  } catch {
    return redirectToAuth({ error: "facebook_session_failed" }, CLEAR_COOKIES);
  }
}

export async function POST() {
  return methodNotAllowed("GET");
}
