// ============================================================
// POST /api/auth/telegram/verify — verifikasi kode OTP.
// Body: { attempt_id, code }. Server cek hash, expiry, attempt
// count, rate limit, one-time use. Sukses (mode login):
// { session_id, expires_at, user } — client simpan session id.
// Sukses (mode link): { linked: true }.
// ============================================================

import { json, methodNotAllowed, readBody } from "@/lib/server/http";
import { verifyAttempt } from "@/lib/server/telegram-auth";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const b = (await readBody(req).catch(() => ({}))) as Record<string, unknown>;
  const attemptId = String(b?.attempt_id || "").trim();
  const code = String(b?.code || "").trim();

  if (!/^[A-Za-z0-9_-]{10,64}$/.test(attemptId) || !/^\d{6}$/.test(code)) {
    return json({ error: "Kode salah atau kedaluwarsa." }, 400);
  }

  const result = await verifyAttempt(req, attemptId, code);
  if (!result.ok) {
    return json({ error: result.error }, result.status as 400 | 401 | 429 | 500);
  }
  if (result.linked) {
    return json({ linked: true });
  }
  return json({
    session_id: result.session!.session_id,
    expires_at: result.session!.expires_at,
  });
}

export async function GET() {
  return methodNotAllowed("POST");
}
