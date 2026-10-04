// ============================================================
// GET /api/auth/discord/callback — tukar code → token → user,
// lalu: link (dari Pengaturan) / login / register sesuai policy.
//
// Account linking policy:
// - discord_ids index → login.
// - Email DISCORD TERVERIFIKASI cocok dengan akun yang ada →
//   tautkan otomatis (provider yang mem-verifikasi email, bukan
//   klaim client).
// - Email cocok tapi TIDAK terverifikasi → tolak dengan pesan
//   untuk masuk manual dulu, lalu hubungkan dari Pengaturan
//   (tidak pernah mengambil alih akun orang lain).
// - Belum ada → daftar akun baru.
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
  type UserRecord,
} from "@/lib/server/oauth";
import { methodNotAllowed } from "@/lib/server/http";

export const dynamic = "force-dynamic";

interface DiscordUser {
  id: string;
  username?: string;
  global_name?: string;
  email?: string;
  verified?: boolean;
}

const CLEAR_COOKIES = ["dc_state", "dc_link"];

function getRedirectUri(req: Request): string {
  if (process.env.DISCORD_REDIRECT_URI) return process.env.DISCORD_REDIRECT_URI;
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
  return `${proto}://${host}/api/auth/discord/callback`;
}

async function exchangeCode(code: string, redirectUri: string): Promise<string | null> {
  const body = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID!,
    client_secret: process.env.DISCORD_CLIENT_SECRET!,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
  try {
    const res = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { access_token?: string };
    return data.access_token || null;
  } catch {
    return null;
  }
}

async function getDiscordUser(accessToken: string): Promise<DiscordUser | null> {
  try {
    const res = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as DiscordUser;
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
    return redirectToAuth({ error: "discord_cancelled" }, CLEAR_COOKIES);
  }
  if (errorParam) {
    return redirectToAuth({ error: "discord_error" }, CLEAR_COOKIES);
  }
  if (!code || !state) {
    return redirectToAuth({ error: "discord_invalid_callback" }, CLEAR_COOKIES);
  }

  const cookieState = getCookie(req.headers, "dc_state");
  if (!cookieState || cookieState !== state) {
    return redirectToAuth({ error: "discord_state_mismatch" }, CLEAR_COOKIES);
  }

  const accessToken = await exchangeCode(code, getRedirectUri(req));
  if (!accessToken) {
    return redirectToAuth({ error: "discord_token_failed" }, CLEAR_COOKIES);
  }

  const user = await getDiscordUser(accessToken);
  if (!user || !user.id) {
    return redirectToAuth({ error: "discord_userinfo_failed" }, CLEAR_COOKIES);
  }

  const discordId = user.id;
  const verifiedEmail = user.verified && user.email ? user.email.toLowerCase() : null;

  // ---- Link mode (Pengaturan): tautkan ke akun yang sedang login ----
  const linkCookie = getCookie(req.headers, "dc_link");
  const linkUserId = verifyLinkValue(linkCookie);
  if (linkCookie) {
    if (!linkUserId) {
      return redirectToAuth({ error: "discord_state_mismatch" }, CLEAR_COOKIES);
    }
    const owner = await findUserByProvider("discord", discordId);
    if (owner && owner !== linkUserId) {
      return redirectToSettings("discord_taken", CLEAR_COOKIES);
    }
    const ok = await linkProviderToUser(linkUserId, "discord", discordId);
    if (!ok) {
      return redirectToSettings("discord_failed", CLEAR_COOKIES);
    }
    return redirectToSettings("discord", CLEAR_COOKIES);
  }

  // ---- Login mode ----
  let userId = await findUserByProvider("discord", discordId);

  if (!userId && verifiedEmail) {
    // Email terverifikasi oleh Discord → boleh tautkan otomatis
    userId = await findUserByEmail(verifiedEmail);
    if (userId) {
      await linkProviderToUser(userId, "discord", discordId);
    }
  }

  // Email cocok tapi tidak diverifikasi Discord → jangan ambil alih akun.
  // Pesan ramah, teknis hanya di log server.
  if (!userId && !verifiedEmail && user.email) {
    const owner = await findUserByEmail(user.email.toLowerCase());
    if (owner) {
      console.error("[discord] link ditolak: email belum terverifikasi Discord");
      return redirectToAuth({ error: "discord_email_taken" }, CLEAR_COOKIES);
    }
  }

  if (!userId) {
    const base = user.global_name || user.username || "user";
    // Email tidak terverifikasi → tidak dipakai sebagai identitas/index.
    userId = await createProviderUser("discord", discordId, base, verifiedEmail);
  }

  try {
    const session = await createSession(userId, true);
    return redirectToAuth({ sid: session.session_id }, CLEAR_COOKIES);
  } catch {
    return redirectToAuth({ error: "discord_session_failed" }, CLEAR_COOKIES);
  }
}

export async function POST() {
  return methodNotAllowed("GET");
}
