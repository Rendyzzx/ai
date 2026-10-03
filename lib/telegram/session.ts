/* ============================================================
   Aomi — lib/telegram/session.ts
   State bot per admin — disimpan di storage dengan TTL 10 menit,
   diperpanjang setiap interaksi. Tidak ada state admin yang
   disimpan tanpa kedaluwarsa.
   ============================================================ */

import { readJson, putJson, expireJson, deleteJson } from "@/lib/server/store";
import { KEYS } from "@/lib/redis/keys";
import type { BotSession } from "./types";

const SESSION_TTL_S = 600;

export async function loadSession(adminId: number): Promise<BotSession> {
  const file = await readJson<BotSession>(KEYS.telegramSession(adminId)).catch(() => null);
  const s = file?.data;
  if (s && typeof s.node === "string" && s.node) {
    return { node: s.node, input: s.input || null, pending: s.pending || null };
  }
  return { node: "MAIN", input: null, pending: null };
}

export async function saveSession(adminId: number, session: BotSession): Promise<void> {
  await putJson(KEYS.telegramSession(adminId), session, "bot session");
  await expireJson(KEYS.telegramSession(adminId), SESSION_TTL_S).catch(() => {});
}

export async function clearSession(adminId: number): Promise<void> {
  await deleteJson(KEYS.telegramSession(adminId)).catch(() => {});
}
