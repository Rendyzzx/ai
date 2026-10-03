/* ============================================================
   Aomi — lib/telegram/api.ts
   Lapisan Telegram Bot API (fetch murni, tanpa SDK — token hanya
   di server, error TIDAK dibocorkan ke chat).
   ============================================================ */

import type { TgInlineKeyboard } from "./types";

const API = "https://api.telegram.org";
const TIMEOUT_MS = 10_000;

function token(): string {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) throw new Error("TELEGRAM_BOT_TOKEN belum diset");
  return t;
}

async function call(method: string, payload: Record<string, unknown>): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API}/bot${token()}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (!res.ok) {
      // Detail error hanya ke log server — jangan pernah dikirim ke chat.
      console.error(`[telegram] ${method} http ${res.status}`);
      return null;
    }
    const out = (await res.json()) as { ok: boolean; result?: unknown };
    return out.ok ? out.result : null;
  } catch (err) {
    console.error(`[telegram] ${method} gagal:`, (err as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function sendMessage(
  chatId: number,
  text: string,
  keyboard?: TgInlineKeyboard
): Promise<void> {
  await call("sendMessage", {
    chat_id: chatId,
    text: text.slice(0, 4000),
    ...(keyboard ? { reply_markup: keyboard } : {}),
  });
}

export async function editMessageText(
  chatId: number,
  messageId: number,
  text: string,
  keyboard?: TgInlineKeyboard
): Promise<boolean> {
  const r = await call("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: text.slice(0, 4000),
    ...(keyboard ? { reply_markup: keyboard } : {}),
  });
  return r !== null;
}

export async function answerCallbackQuery(id: string, text?: string): Promise<void> {
  await call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });
}

/** Kirim dokumen (mis. hasil export) sebagai attachment. */
export async function sendDocument(
  chatId: number,
  filename: string,
  mime: string,
  bytes: Uint8Array,
  caption?: string
): Promise<void> {
  try {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (caption) form.append("caption", caption.slice(0, 900));
    form.append("document", new Blob([bytes as BlobPart], { type: mime }), filename);
    const res = await fetch(`${API}/bot${token()}/sendDocument`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) console.error(`[telegram] sendDocument http ${res.status}`);
  } catch (err) {
    console.error("[telegram] sendDocument gagal:", (err as Error).message);
  }
}

/** getFile → file_path server Telegram (untuk download bytes). */
export async function getFile(fileId: string): Promise<string | null> {
  const r = await call("getFile", { file_id: fileId });
  if (!r || typeof r !== "object" || !("file_path" in r)) return null;
  return (r as { file_path?: string }).file_path ?? null;
}

/** Download bytes file dari server Telegram (setelah getFile). */
export async function downloadTgFile(filePath: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(`${API}/file/bot${token()}/${filePath}`, { cache: "no-store" });
    if (!res.ok) {
      console.error(`[telegram] download file http ${res.status}`);
      return null;
    }
    return new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    console.error("[telegram] download file gagal:", (err as Error).message);
    return null;
  }
}

/** Kirim foto dari bytes (preview asset di menu bot). */
export async function sendPhotoBytes(
  chatId: number,
  bytes: Uint8Array,
  mime: string,
  caption?: string
): Promise<boolean> {
  try {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (caption) form.append("caption", caption.slice(0, 900));
    form.append("photo", new Blob([bytes as BlobPart], { type: mime }), "asset.jpg");
    const res = await fetch(`${API}/bot${token()}/sendPhoto`, { method: "POST", body: form });
    return res.ok;
  } catch (err) {
    console.error("[telegram] sendPhoto gagal:", (err as Error).message);
    return false;
  }
}
