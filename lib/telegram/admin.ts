/* ============================================================
   Aomi — lib/telegram/admin.ts
   Authorization admin: HANYA numeric Telegram user id dari env
   TELEGRAM_ADMIN_IDS. Username/nama TIDAK PERNAH dipercaya.
   File ini murni (tanpa import) supaya bisa dites langsung.

   Format env: "123456789" atau "123456789:owner,98765:viewer"
   Role default untuk id pertama tanpa suffix: OWNER.
   ============================================================ */

export type Role = "OWNER" | "ADMIN" | "OPERATOR" | "VIEWER";
export type Permission = "read" | "operate" | "manage" | "owner";

export interface AdminUser {
  id: number;
  role: Role;
}

const RANK: Record<Role, number> = { OWNER: 4, ADMIN: 3, OPERATOR: 2, VIEWER: 1 };
const REQUIRED: Record<Permission, number> = { read: 1, operate: 2, manage: 3, owner: 4 };

export function parseAdmins(env: string | undefined): AdminUser[] {
  const out: AdminUser[] = [];
  const seen = new Set<number>();
  for (const part of String(env || "").split(/[,\s]+/)) {
    if (!part) continue;
    const m = part.trim().match(/^(\d{3,15})(?::(owner|admin|operator|viewer))?$/i);
    if (!m) continue;
    const id = Number(m[1]);
    if (!Number.isFinite(id) || seen.has(id)) continue;
    // Role disimpan lowercase; entri dengan role TIDAK dikenal ditolak
    // (fail closed — jangan pernah fallback ke OWNER diam-diam).
    // Role disimpan UPPERCASE; entri dengan role TIDAK dikenal ditolak
    // (fail closed — jangan pernah fallback ke OWNER diam-diam).
    const roleStr = (m[2] || "owner").toUpperCase();
    if (!RANK[roleStr as Role]) continue;
    const role = roleStr as Role;
    seen.add(id);
    out.push({ id, role });
  }
  return out;
}

export function findAdmin(admins: AdminUser[], userId: number): AdminUser | null {
  return admins.find((a) => a.id === userId) || null;
}

/** Apakah admin boleh melakukan kelas aksi ini? */
export function can(admin: AdminUser, perm: Permission): boolean {
  // role disimpan lowercase di parseAdmins; lookup key RANK uppercase.
  const rank = RANK[(admin.role || "").toUpperCase() as Role] || 0;
  return rank >= REQUIRED[perm];
}

export function roleLabel(role: Role): string {
  return role;
}
