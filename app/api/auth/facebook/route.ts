// ============================================================
// GET /api/auth/facebook — mulai Facebook Login (server-side,
// state cookie HttpOnly; link mode via cookie signed).
// ============================================================

import crypto from "node:crypto";
import { json, methodNotAllowed } from "@/lib/server/http";
import { getSession } from "@/lib/server/auth";
import { signLinkValue } from "@/lib/server/oauth";

export const dynamic = "force-dynamic";

const SCOPES = "email,public_profile";

function getRedirectUri(req: Request): string {
  if (process.env.FACEBOOK_REDIRECT_URI) return process.env.FACEBOOK_REDIRECT_URI;
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
  return `${proto}://${host}/api/auth/facebook/callback`;
}

export async function GET(req: Request) {
  const clientId = process.env.FACEBOOK_CLIENT_ID;
  const clientSecret = process.env.FACEBOOK_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return json({ error: "Facebook OAuth belum dikonfigurasi." }, 500);
  }

  const url = new URL(req.url);
  const wantLink = url.searchParams.get("link") === "1";
  const state = crypto.randomBytes(32).toString("base64url");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getRedirectUri(req),
    state,
    scope: SCOPES,
  });
  const authUrl = `https://www.facebook.com/v19.0/dialog/oauth?${params.toString()}`;

  const cookies: string[] = [
    `fb_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`,
  ];

  if (wantLink) {
    const session = await getSession(req.headers);
    if (!session) {
      return json({ error: "Sesi berakhir. Silakan login kembali.", code: "SESSION_INVALID" }, 401);
    }
    cookies.push(
      `fb_link=${signLinkValue(session.user_id)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`
    );
  }

  if (url.searchParams.get("json") === "1") {
    const res = json({ url: authUrl });
    res.headers.append("Set-Cookie", cookies.join(", "));
    return res;
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl,
      "Set-Cookie": cookies.join(", "),
      "Cache-Control": "no-store",
    },
  });
}

export async function POST() {
  return methodNotAllowed("GET");
}
