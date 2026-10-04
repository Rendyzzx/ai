/* ============================================================
   Aomi — lib/telegram/types.ts
   Tipe Telegram yang dipakai bot (subset minimal).
   ============================================================ */

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type?: string;
}

export interface TgPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  /** Foto yang dikirim admin (upload asset character/banner). */
  photo?: TgPhotoSize[];
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: { message_id: number; chat: TgChat };
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface TgButton {
  text: string;
  callback_data?: string;
  url?: string; // tombol tautan (mis. "Buka Aomi" untuk kode login)
}

export interface TgInlineKeyboard {
  inline_keyboard: TgButton[][];
}

/** State per admin (node state machine + data sementara). */
export interface BotSession {
  node: string; // MAIN / MAINT / DB / USERS / FEAT / MON / SEC / CFG / ANN / AUDIT
  input?: string | null; // sedang menunggu input teks: "maint_msg" | "maint_sched" | "user_search" | "ann_set"
  pending?: { menu: string; action: string } | null; // aksi yang menunggu konfirmasi
}
