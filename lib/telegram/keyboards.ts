/* ============================================================
   Aomi — lib/telegram/keyboards.ts
   Semua inline keyboard bot — selalu ada tombol kembali di submenu.
   ============================================================ */

import type { TgInlineKeyboard } from "./types";

const kb = (rows: [string, string][][]): TgInlineKeyboard => ({
  inline_keyboard: rows.map((row) =>
    row.map(([text, data]) => ({ text, callback_data: data }))
  ),
});

export const BACK_MAIN: [string, string][][] = [[["⬅️ Menu utama", "nav:MAIN"]]];

export function mainMenu(statusLine: string): TgInlineKeyboard {
  return kb([
    [["🖥 Website", "web"], ["🛠 Maintenance", "nav:MAINT"]],
    [["👥 Users", "nav:USERS"], ["🗄 Database", "nav:DB"]],
    [["🤖 AI & Tools", "nav:FEAT"], ["📊 Monitoring", "nav:MON"]],
    [["⚙️ Pengaturan Website", "nav:SITE"], ["🔐 Security", "nav:SEC"]],
    [["📢 Announcement", "nav:ANN"], ["🧾 Audit Log", "nav:AUDIT"]],
    [["🔄 Refresh", "menu"]],
  ]);
}

export function maintenanceMenu(active: boolean): TgInlineKeyboard {
  const toggle: [string, string] = active
    ? ["🟢 Maintenance ON — nonaktifkan", "maint:off"]
    : ["🔴 Maintenance OFF — aktifkan", "maint:on"];
  return kb([
    [toggle],
    [["✏️ Ubah pesan", "maint:msg"], ["🗓 Jadwal", "maint:sched"]],
    [["👁 Preview", "maint:preview"]],
    ...BACK_MAIN,
  ]);
}

export function confirmKeyboard(yesLabel: string): TgInlineKeyboard {
  return kb([
    [["❌ Batalkan", "cancel"], [yesLabel, "yes"]],
  ]);
}

export function databaseMenu(): TgInlineKeyboard {
  return kb([
    [["🩺 Status", "db:status"], ["ℹ️ Redis Info", "db:redis"]],
    [["🧹 Cleanup", "db:cleanup"], ["📦 Export", "db:export"]],
    [["📈 Statistik", "db:stats"]],
    ...BACK_MAIN,
  ]);
}

export function usersMenu(): TgInlineKeyboard {
  return kb([
    [["🔎 Cari user", "users:search"], ["🕒 Terbaru", "users:recent"]],
    [["📈 Statistik", "users:stats"]],
    ...BACK_MAIN,
  ]);
}

export function backToUsers(): TgInlineKeyboard {
  return kb([[["⬅️ Kembali", "nav:USERS"]] as [string, string][]]);
}

export function featureMenu(): TgInlineKeyboard {
  return kb([
    [["chat", "feat:chat"], ["music", "feat:music"]],
    [["image-edit", "feat:image-edit"], ["imggen", "feat:imggen"]],
    [["hd", "feat:hd"], ["dl", "feat:dl"]],
    [["video", "feat:video"]],
    [["pin", "feat:pin"], ["bookmark", "feat:bookmark"]],
    [["search", "feat:search"], ["feedback", "feat:feedback"]],
    ...BACK_MAIN,
  ]);
}

export function monitoringMenu(): TgInlineKeyboard {
  return kb([
    [["🔄 Refresh", "nav:MON"]],
    ...BACK_MAIN,
  ]);
}

export function securityMenu(): TgInlineKeyboard {
  return kb([
    [["🚫 Revoke semua sesi", "sec:revoke"]],
    ...BACK_MAIN,
  ]);
}

export function configMenu(): TgInlineKeyboard {
  return kb([
    [["📢 Pengumuman", "nav:ANN"], ["🚩 Fitur", "nav:FEAT"]],
    [["📏 Limits (lihat)", "cfg:limits"]],
    [["🛠 Pesan maintenance", "maint:preview"]],
    ...BACK_MAIN,
  ]);
}

export function announcementMenu(enabled: boolean): TgInlineKeyboard {
  const toggle: [string, string] = enabled
    ? ["🟢 Aktif — nonaktifkan", "ann:off"]
    : ["⚪ Nonaktif — aktifkan", "ann:on"];
  return kb([
    [toggle],
    [["✏️ Set judul & pesan", "ann:set"], ["👁 Preview", "ann:preview"]],
    ...BACK_MAIN,
  ]);
}

export function auditMenu(): TgInlineKeyboard {
  return kb([
    [["🔄 Refresh", "nav:AUDIT"]],
    ...BACK_MAIN,
  ]);
}

export function usersListKeyboard(items: { id: string; label: string }[]): TgInlineKeyboard {
  const rows: [string, string][][] = items.map(
    (it) => [[it.label.slice(0, 40), `user:${it.id}`]] as [string, string][]
  );
  return kb([...rows.slice(0, 6), [["⬅️ Kembali", "nav:USERS"]]]);
}

export function userDetailKeyboard(userId: string, suspended: boolean): TgInlineKeyboard {
  const action: [string, string] = suspended
    ? ["✅ Unsuspend", `userunsuspend:${userId}`]
    : ["⛔ Suspend", `usersuspend:${userId}`];
  return kb([[action], [["⬅️ Kembali", "nav:USERS"]]]);
}

/** Submenu ⚙️ Pengaturan Website. */
export function siteMenu(): TgInlineKeyboard {
  return kb([
    [["🛠 Maintenance", "nav:MAINT"]],
    [["🎭 Character", "nav:CHAR"], ["🖼️ Login Banner", "nav:BANNER"]],
    [["🌐 Tampilan & Limits", "nav:CFG"]],
    ...BACK_MAIN,
  ]);
}

/** Menu satu asset (character / banner). */
export function assetMenu(prefix: "char" | "banner" | "bannerm"): TgInlineKeyboard {
  return kb([
    [["📤 Ganti", `${prefix}:replace`], ["👁 Lihat", `${prefix}:view`]],
    [["🗑 Hapus (kembali ke default)", `${prefix}:delete`]],
    [["⬅️ Kembali", "nav:SITE"]],
  ]);
}

/** Menu Login Banner — dua komposisi terpisah (desktop vs mobile).
 *  Mengganti satu TIDAK menyentuh yang lain. */
export function bannerMenu(): TgInlineKeyboard {
  return kb([
    [["🖥 Ganti Desktop", "banner:replace"], ["📱 Ganti Mobile", "bannerm:replace"]],
    [["👁 Lihat Desktop", "banner:view"], ["👁 Lihat Mobile", "bannerm:view"]],
    [["🗑 Hapus Desktop", "banner:delete"], ["🗑 Hapus Mobile", "bannerm:delete"]],
    [["⬅️ Kembali", "nav:SITE"]],
  ]);
}

/** Keyboard saat bot menunggu admin mengirim foto. */
export function awaitingPhotoMenu(prefix: "char" | "banner" | "bannerm"): TgInlineKeyboard {
  return kb([[["❌ Batalkan", "cancel"]]]);
}
