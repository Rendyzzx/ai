// GET /api/auth/me → info user dari session (untuk restore login)

import { getSession } from "@/lib/server/auth";
import { readJson } from "@/lib/server/store";
import { APP_VERSION } from "@/lib/server/version";
import { json, methodNotAllowed } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await getSession(req.headers);
  if (!session) return json({ error: "Belum login", code: "SESSION_INVALID" }, 401);

  const userFile = await readJson<{ id: string; username: string; email: string }>(`users/${session.user_id}.json`);
  if (!userFile) return json({ error: "User tidak ditemukan", code: "SESSION_INVALID" }, 401);

  const u = userFile.data;
  return json({
    user: { id: u.id, username: u.username, email: u.email },
    app_version: APP_VERSION,
  });
}

export async function POST() {
  return methodNotAllowed("GET");
}
