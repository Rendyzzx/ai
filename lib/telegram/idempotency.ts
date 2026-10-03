/* ============================================================
   Aomi — lib/telegram/idempotency.ts
   Telegram bisa mengirim ulang update (retry). Tandai update_id yang
   sudah diproses (TTL 1 jam) supaya satu aksi tidak pernah
   dieksekusi dua kali.
   ============================================================ */

import { putJsonIfAbsent } from "@/lib/server/store";
import { KEYS } from "@/lib/redis/keys";

export async function markUpdateSeen(updateId: number): Promise<boolean> {
  try {
    return await putJsonIfAbsent(KEYS.telegramSeen(updateId), { at: Date.now() }, 3600);
  } catch (err) {
    // Storage error saat penandaan → anggap BARU (biar aksi tetap jalan;
    // duplikat jarang dan kurang berbahaya daripada aksi hilang).
    console.error("[telegram] markUpdateSeen gagal:", (err as Error).message);
    return true;
  }
}
