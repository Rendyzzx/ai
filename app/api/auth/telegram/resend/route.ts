// ============================================================
// POST /api/auth/telegram/resend — kirim ulang kode OTP.
// Body: { attempt_id }. Cooldown 60 detik, max 3 kali per attempt.
// ============================================================

import { json, methodNotAllowed, readBody } from "@/lib/server/http";
import { resendAttempt } from "@/lib/server/telegram-auth";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const b = (await readBody(req).catch(() => ({}))) as Record<string, unknown>;
  const attemptId = String(b?.attempt_id || "").trim();
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(attemptId)) {
    return json({ error: "Permintaan login tidak ditemukan. Mulai ulang." }, 400);
  }
  const result = await resendAttempt(req, attemptId);
  if (!result.ok) {
    return json({ error: result.error }, result.status as 400 | 401 | 429 | 500);
  }
  return json({ ok: true });
}

export async function GET() {
  return methodNotAllowed("POST");
}
