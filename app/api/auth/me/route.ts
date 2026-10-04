// GET /api/auth/me → info user dari session (untuk restore login)

import { getSession } from "@/lib/server/auth";
import { readJson } from "@/lib/server/store";
import { APP_VERSION } from "@/lib/server/version";
import { json, methodNotAllowed } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await getSession(req.headers);
  if (!session) return json({ error: "Belum login", code: "SESSION_INVALID" }, 401);

  const userFile = await readJson<{
    id: string;
    username: string;
    email: string | null;
    password_hash?: string;
    google_id?: string;
    discord_id?: string;
    facebook_id?: string;
    telegram_id?: number;
  }>(`users/${session.user_id}.json`);
  if (!userFile) return json({ error: "User tidak ditemukan", code: "SESSION_INVALID" }, 401);

  const u = userFile.data;
  return json({
    // boolean saja — ID provider asli tidak pernah dikirim ke klien.
    user: {
      id: u.id,
      username: u.username,
      email: u.email,
      google_linked: Boolean(u.google_id),
      providers: {
        google: Boolean(u.google_id),
        discord: Boolean(u.discord_id),
        facebook: Boolean(u.facebook_id),
        telegram: Boolean(u.telegram_id),
      },
    },
    app_version: APP_VERSION,
  });
}

export async function POST() {
  return methodNotAllowed("GET");
}
