// ============================================================
// GET /api/auth/discord — mulai Discord OAuth2 (server-side).
// State disimpan di cookie HttpOnly (CSRF). Link mode (?link=1,
// dengan header session) → cookie signed, dipakai callback untuk
// menautkan ke akun yang sedang login.
// ============================================================

import crypto from "node:crypto";
import { json, methodNotAllowed } from "@/lib/server/http";
import { getSession } from "@/lib/server/auth";
import { signLinkValue } from "@/lib/server/oauth";

export const dynamic = "force-dynamic";

const SCOPES = "identify email";

function getRedirectUri(req: Request): string {
  if (process.env.DISCORD_REDIRECT_URI) return process.env.DISCORD_REDIRECT_URI;
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
  return `${proto}://${host}/api/auth/discord/callback`;
}

export async function GET(req: Request) {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return json({ error: "Discord OAuth belum dikonfigurasi." }, 500);
  }

  const url = new URL(req.url);
  const wantLink = url.searchParams.get("link") === "1";
  const state = crypto.randomBytes(32).toString("base64url");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getRedirectUri(req),
    response_type: "code",
    scope: SCOPES,
    state,
    prompt: "consent",
  });
  const authUrl = `https://discord.com/oauth2/authorize?${params.toString()}`;

  const cookies: string[] = [
    `dc_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`,
  ];

  // Link mode: WAJIB ada session valid → cookie signed berisi user id.
  if (wantLink) {
    const session = await getSession(req.headers);
    if (!session) {
      return json({ error: "Sesi berakhir. Silakan login kembali.", code: "SESSION_INVALID" }, 401);
    }
    cookies.push(
      `dc_link=${signLinkValue(session.user_id)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`
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
