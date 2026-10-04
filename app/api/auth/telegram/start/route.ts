// ============================================================
// POST /api/auth/telegram/start — mulai attempt login Telegram.
// Body kosong → mode login. Header session valid + {link:true}
// → mode link (dari Pengaturan "Akun terhubung").
// Response: { attempt_id, bot_username, expires_in }.
// ============================================================

import { json, methodNotAllowed, readBody } from "@/lib/server/http";
import { getSession } from "@/lib/server/auth";
import { enabledProviders } from "@/lib/server/oauth";
import { startAttempt, getBotUsername } from "@/lib/server/telegram-auth";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!enabledProviders().telegram) {
    return json({ error: "Login Telegram belum tersedia." }, 503);
  }

  const body = (await readBody(req).catch(() => ({}))) as Record<string, unknown>;
  let linkUserId: string | null = null;
  if (body?.link === true) {
    const session = await getSession(req.headers);
    if (!session) {
      return json({ error: "Sesi berakhir. Silakan login kembali.", code: "SESSION_INVALID" }, 401);
    }
    linkUserId = session.user_id;
  }

  const result = await startAttempt(req, linkUserId);
  if (!result.ok) {
    return json({ error: result.error }, result.status as 400 | 401 | 429 | 503 | 500);
  }

  const bot = await getBotUsername();
  return json({
    attempt_id: result.attempt!.id,
    bot_username: bot,
    expires_in: result.attempt!.expires_in,
  });
}

export async function GET() {
  return methodNotAllowed("POST");
}
