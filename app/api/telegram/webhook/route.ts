/* ============================================================
   Aomi — /api/telegram/webhook (Route Handler)
   Webhook Telegram Bot API — pusat administrasi Aomi.

   Keamanan:
   - Hanya POST; verifikasi header secret X-Telegram-Bot-Api-Secret-Token
   - Idempotent: update_id yang sudah diproses di-skip (TTL 1 jam)
   - Rate limit per IP (anti abuse/loop, bukan anti admin)
   - Authorization HANYA numeric Telegram user id (env TELEGRAM_ADMIN_IDS)
   - Non-admin: dicatat + jawab "Akses ditolak." tanpa info internal
   - Error internal tidak pernah dibocorkan ke chat — hanya log server
   ============================================================ */

import { json } from "@/lib/server/http";
import { allowIp, clientIp, securityLog } from "@/lib/server/ratelimit";
import { parseAdmins, findAdmin } from "@/lib/telegram/admin";
import type { TgUpdate } from "@/lib/telegram/types";
import { markUpdateSeen } from "@/lib/telegram/idempotency";
import { handleUpdate } from "@/lib/telegram/router";
import { sendMessage, answerCallbackQuery } from "@/lib/telegram/api";
import { recordUnauthorized } from "@/lib/server/adminsvc";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  return json({ error: "Method tidak diizinkan" }, 405);
}

export async function POST(req: Request) {
  // Fail closed: tanpa secret terkonfigurasi, webhook menolak semua.
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) {
    securityLog("TG_WEBHOOK_UNCONFIGURED", { ip: clientIp(req.headers) });
    return json({ error: "Service tidak tersedia." }, 503);
  }

  const got = req.headers.get("x-telegram-bot-api-secret-token") || "";
  if (got !== secret) {
    // Jangan bocorkan apa pun — 403 generik.
    securityLog("TG_WEBHOOK_BAD_SECRET", { ip: clientIp(req.headers) });
    return json({ error: "Terlarang." }, 403);
  }

  // Rate limit reasonable (120/menit/IP) — tidak mengganggu pemakaian normal.
  if (!allowIp("tgwebhook", req, 120, 60_000)) {
    return json({ ok: true }, 429);
  }

  let update: TgUpdate | null = null;
  try {
    update = (await req.json()) as TgUpdate;
  } catch {
    return json({ ok: true }); // payload rusak → anggap selesai (Telegram jangan retry)
  }
  if (!update || typeof update.update_id !== "number") {
    return json({ ok: true });
  }

  // Idempotency: update yang sama TIDAK dieksekusi dua kali.
  const fresh = await markUpdateSeen(update.update_id);
  if (!fresh) {
    return json({ ok: true });
  }

  const from = update.message?.from || update.callback_query?.from || null;
  if (!from || typeof from.id !== "number") {
    return json({ ok: true });
  }

  const admins = parseAdmins(process.env.TELEGRAM_ADMIN_IDS);
  const admin = findAdmin(admins, from.id);
  const chatId =
    update.message?.chat?.id ||
    update.edited_message?.chat?.id ||
    update.callback_query?.message?.chat?.id ||
    from.id;

  if (!admin) {
    // Catat percobaan (id disamarkan) + jawab minimalis.
    await recordUnauthorized(from.id);
    securityLog("TG_ADMIN_DENIED", { ip: clientIp(req.headers), uid: String(from.id).slice(0, 2) + "***" });
    if (update.callback_query) {
      await answerCallbackQuery(update.callback_query.id, "Akses ditolak.");
    } else {
      await sendMessage(chatId, "Akses ditolak.");
    }
    return json({ ok: true });
  }

  try {
    await handleUpdate(update, admin);
  } catch (err) {
    // Detail error hanya ke log server — tidak pernah ke chat.
    console.error("[telegram] handleUpdate gagal:", (err as Error).message);
    await sendMessage(chatId, "❌ Operasi gagal. Detail tercatat di log server.").catch(() => {});
  }

  return json({ ok: true });
}
