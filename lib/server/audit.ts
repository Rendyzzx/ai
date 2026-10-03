/* ============================================================
   Aomi — lib/server/audit.ts
   Audit log aksi admin — disimpan terstruktur (cap 100 entri,
   data minimal, TANPA secret). Setiap aksi penting bot mencatat:
   admin, aksi, target, hasil, waktu.
   ============================================================ */

import { readJson, updateJson } from "./store";
import { KEYS } from "@/lib/redis/keys";

export interface AuditEntry {
  at: string; // ISO
  admin_id: number; // Telegram user id
  role: string; // OWNER / ADMIN / OPERATOR / VIEWER
  action: string; // mis. "maintenance.enabled"
  target: string; // mis. "site" / "flag:hd" / "user:<id>"
  result: "ok" | "fail";
  detail: string; // metadata MINIMAL, tanpa secret
}

interface AuditLog {
  entries: AuditEntry[];
}

const MAX_ENTRIES = 100;

export async function auditLog(entry: Omit<AuditEntry, "at">): Promise<void> {
  try {
    await updateJson<AuditLog>(
      KEYS.auditLog,
      "audit append",
      (current) => {
        const log: AuditLog = current || { entries: [] };
        const entries = Array.isArray(log.entries) ? log.entries : [];
        entries.push({ ...entry, at: new Date().toISOString() });
        return { entries: entries.slice(-MAX_ENTRIES) };
      }
    );
  } catch (err) {
    // audit gagal tidak boleh menjatuhkan aksi; catat di log server saja
    console.error("[audit] gagal menulis:", (err as Error).message);
  }
}

export async function auditRecent(count = 8): Promise<AuditEntry[]> {
  const file = await readJson<AuditLog>(KEYS.auditLog).catch(() => null);
  const entries = file?.data?.entries || [];
  return entries.slice(-count).reverse();
}
