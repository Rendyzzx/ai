/* ============================================================
   Aomi — lib/telegram/handlers/types.ts
   Kontrak handler menu: render (tampilan) + onAction (tombol,
   dengan pola konfirmasi) + onInput (menunggu teks dari admin).
   ============================================================ */

import type { AdminUser } from "../admin";
import type { BotSession, TgInlineKeyboard, TgPhotoSize } from "../types";

export interface Ctx {
  admin: AdminUser;
  session: BotSession;
}

export interface View {
  text: string;
  kb: TgInlineKeyboard;
}

export interface MenuHandler {
  /** Nama node sesi yang dimiliki handler ini. */
  node: string;
  render(ctx: Ctx): Promise<View>;
  /**
   * Aksi tombol. `confirmed=false` untuk aksi sensitif → kembalikan View
   * konfirmasi (router menyimpan pending). `confirmed=true` → eksekusi.
   * Return null jika aksi tidak dikenal handler ini.
   */
  onAction(action: string, ctx: Ctx, confirmed: boolean): Promise<View | null>;
  /** Input teks saat session.input aktif di node ini. Return null jika tidak menangani. */
  onInput(text: string, ctx: Ctx): Promise<View | null>;
  /** Input foto saat session.input foto aktif (upload asset). Opsional.
   *  chatId = chat asal pesan (untuk kirim konfirmasi/preview). */
  onPhoto?(photo: TgPhotoSize[], ctx: Ctx, chatId: number): Promise<View | null>;
}

export const DENIED = "⛔ Akses ditolak untuk aksi ini.";
