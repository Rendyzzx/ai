/* ============================================================
   Aomi — lib/redis/keys.ts
   Definisi TERPUSAT semua key storage untuk fitur baru (bot
   Telegram admin, maintenance, feature flags, audit, dst).

   Catatan: lib/server/store.ts otomatis menambahkan prefix
   "aomi:" pada setiap path (fungsi keyOf). Path di file ini
   TANPA prefix — contoh "maintenance/state.json" menjadi
   key Redis "aomi:maintenance/state.json".

   Struktur key:
     aomi:maintenance/state.json     — mode ON/OFF/scheduled
     aomi:maintenance/config.json   — judul/pesan/estimasi halaman
     aomi:announcement/state.json   — banner pengumuman website
     aomi:features/state.json        — feature flags (1 record)
     aomi:audit/log.json             — log aksi admin (cap 100)
     aomi:telegram/session/<id>.json — state bot per admin (TTL 10m)
     aomi:telegram/seen/<upid>.json  — update Telegram sudah diproses (TTL 1j)
     aomi:telegram/security.json     — statistik akses tanpa izin
     aomi:users/suspended.json       — daftar id user dibekukan
   ============================================================ */

export const KEYS = {
  maintenanceState: "maintenance/state.json",
  maintenanceConfig: "maintenance/config.json",
  announcement: "announcement/state.json",
  features: "features/state.json",
  auditLog: "audit/log.json",
  telegramSession: (adminId: number) => `telegram/session/${adminId}.json`,
  telegramSeen: (updateId: number) => `telegram/seen/${updateId}.json`,
  telegramSecurity: "telegram/security.json",
  suspendedUsers: "users/suspended.json",
  healthcheck: "status/_healthcheck.json",
} as const;
