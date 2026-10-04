// ============================================================
// GET /api/auth/config — provider login yang aktif (publik).
// Hanya boolean + username bot — tidak ada secret/id internal.
// UI memakai ini untuk menampilkan tombol provider yang tersedia.
// ============================================================

import { json, methodNotAllowed } from "@/lib/server/http";
import { enabledProviders } from "@/lib/server/oauth";
import { getBotUsername } from "@/lib/server/telegram-auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const providers = enabledProviders();
  let telegram_bot: string | null = null;
  if (providers.telegram) {
    telegram_bot = await getBotUsername();
    // Bot tidak terbaca → jangan tampilkan Telegram (deep link butuh username)
    if (!telegram_bot) providers.telegram = false;
  }
  return json({ providers, telegram_bot });
}

export async function POST() {
  return methodNotAllowed("GET");
}
