// POST /api/auth/logout → hapus session di storage (client bersihkan sessionStorage)

import { destroySession } from "@/lib/server/auth";
import { json, methodNotAllowed } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  await destroySession(req.headers);
  return json({ ok: true });
}

export async function GET() {
  return methodNotAllowed("POST");
}
