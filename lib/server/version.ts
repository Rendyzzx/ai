/* ============================================================
   Aomi — lib/server/version.ts
   APP_VERSION HANYA dari Environment Variables (jangan fallback
   ke commit SHA — tiap push akan me-logout semua user).
   ============================================================ */

export const APP_VERSION = process.env.APP_VERSION || "dev";
