/* ============================================================
   Aomi — lib/telegram/router.ts
   State machine bot: pesan teks & callback → handler → view.
   Konfirmasi lewat session.pending (bukan teks yang bisa dipicu
   ulang), navigasi lewat nav:<NODE>.
   ============================================================ */

import type { AdminUser } from "./admin";
import type { TgUpdate } from "./types";
import { MENU_HANDLERS, renderMain } from "./handlers";
import type { View, Ctx } from "./handlers/types";
import { sendMessage, editMessageText, answerCallbackQuery } from "./api";
import { loadSession, saveSession } from "./session";

interface BotIO {
  chatId: number;
  messageId: number | null;
}

const ctxOf = (admin: AdminUser, session: import("./types").BotSession): Ctx => ({ admin, session });

async function sendView(io: BotIO, view: View, edit: boolean): Promise<void> {
  if (edit && io.messageId) {
    const ok = await editMessageText(io.chatId, io.messageId, view.text, view.kb);
    if (ok) return;
  }
  await sendMessage(io.chatId, view.text, view.kb);
}

const HINT =
  "Perintah yang dikenal: /menu (menu utama).\nMenu lain lewat tombol di pesan menu utama.";

/** Proses satu update Telegram yang SUDAH diverifikasi admin-nya. */
export async function handleUpdate(update: TgUpdate, admin: AdminUser): Promise<void> {
  // ---- Callback query (klik tombol inline) ----
  if (update.callback_query) {
    const cb = update.callback_query;
    const data = String(cb.data || "");
    const chatId = cb.message?.chat?.id ?? admin.id;
    const io: BotIO = { chatId, messageId: cb.message?.message_id ?? null };
    const session = await loadSession(admin.id);

    try {
      if (data === "yes" && session.pending) {
        const handler = MENU_HANDLERS[session.pending.menu];
        const action = session.pending.action;
        session.pending = null;
        if (!handler) {
          await answerCallbackQuery(cb.id, "❌ Sesi menu sudah kedaluwarsa.");
          session.node = "MAIN";
          await sendView(io, await renderMain(), true);
          await saveSession(admin.id, session);
          return;
        }
        const view = await handler.onAction(action, ctxOf(admin, session), true);
        await answerCallbackQuery(cb.id);
        await sendView(io, view || (await renderMain()), true);
        await saveSession(admin.id, session);
        return;
      }

      if (data === "cancel" || data === "no") {
        session.pending = null;
        session.input = null;
        await answerCallbackQuery(cb.id, "Dibatalkan.");
        const handler = MENU_HANDLERS[session.node] || MENU_HANDLERS.MAIN;
        await sendView(io, await handler.render(ctxOf(admin, session)), true);
        await saveSession(admin.id, session);
        return;
      }

      if (data === "menu") {
        session.pending = null;
        session.input = null;
        session.node = "MAIN";
        await answerCallbackQuery(cb.id);
        await sendView(io, await renderMain(), true);
        await saveSession(admin.id, session);
        return;
      }

      if (data.startsWith("nav:")) {
        const target = data.slice(4);
        const handler = MENU_HANDLERS[target];
        session.pending = null;
        session.input = null;
        if (handler) {
          session.node = target;
          await answerCallbackQuery(cb.id);
          await sendView(io, await handler.render(ctxOf(admin, session)), true);
        } else {
          await answerCallbackQuery(cb.id);
          await sendView(io, await renderMain(), true);
        }
        await saveSession(admin.id, session);
        return;
      }

      // Aksi milik node sekarang, lalu fallback lintas node.
      const current = MENU_HANDLERS[session.node];
      let view = current ? await current.onAction(data, ctxOf(admin, session), false) : null;
      if (!view) {
        for (const h of Object.values(MENU_HANDLERS)) {
          if (h === current) continue;
          view = await h.onAction(data, ctxOf(admin, session), false);
          if (view) break;
        }
      }
      if (view) {
        await answerCallbackQuery(cb.id);
        await sendView(io, view, true);
      } else {
        await answerCallbackQuery(cb.id, "Menu tidak dikenal.");
      }
      await saveSession(admin.id, session);
      return;
    } catch (err) {
      console.error("[telegram] callback error:", (err as Error).message);
      await answerCallbackQuery(cb.id).catch(() => {});
      await sendMessage(chatId, "❌ Operasi gagal. Detail tercatat di log server.").catch(() => {});
      await saveSession(admin.id, session).catch(() => {});
      return;
    }
  }

  // ---- Pesan (teks ATAU foto upload asset) ----
  const msg = update.message || update.edited_message;
  if (!msg) return;

  // Foto dari admin (upload character / login banner).
  if (msg.photo?.length) {
    const io: BotIO = { chatId: msg.chat.id, messageId: null };
    const session = await loadSession(admin.id);
    try {
      const handler = MENU_HANDLERS[session.node];
      if (handler?.onPhoto) {
        const view = await handler.onPhoto(msg.photo, ctxOf(admin, session), io.chatId);
        if (view) {
          await sendMessage(io.chatId, view.text, view.kb);
          await saveSession(admin.id, session);
          return;
        }
      }
      // Foto tidak dikenal node saat ini → abaikan (jangan bocorkan state)
      await saveSession(admin.id, session);
      return;
    } catch (err) {
      console.error("[telegram] photo error:", (err as Error).message);
      await sendMessage(io.chatId, "❌ Upload gagal. Detail tercatat di log server.").catch(() => {});
      await saveSession(admin.id, session).catch(() => {});
      return;
    }
  }

  if (!msg.text) return;
  const text = msg.text.trim();
  const io: BotIO = { chatId: msg.chat.id, messageId: null };
  const session = await loadSession(admin.id);

  try {
    if (text === "/start" || text === "/menu" || text === "menu") {
      session.node = "MAIN";
      session.pending = null;
      session.input = null;
      const view = await renderMain();
      await sendMessage(io.chatId, view.text, view.kb);
      await saveSession(admin.id, session);
      return;
    }

    if (session.input) {
      const current = MENU_HANDLERS[session.node];
      const view = current ? await current.onInput(text, ctxOf(admin, session)) : null;
      if (view) {
        await sendMessage(io.chatId, view.text, view.kb);
        await saveSession(admin.id, session);
        return;
      }
    }

    await sendMessage(io.chatId, HINT);
    await saveSession(admin.id, session);
  } catch (err) {
    console.error("[telegram] message error:", (err as Error).message);
    await sendMessage(io.chatId, "❌ Operasi gagal. Detail tercatat di log server.").catch(() => {});
    await saveSession(admin.id, session).catch(() => {});
  }
}
