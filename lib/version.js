// ============================================================
// Aomi — lib/version.js
// APP_VERSION HANYA dari Environment Variables Vercel
// (spec: contoh 2026.10.02.001).
//
// PENTING: JANGAN fallback ke VERCEL_GIT_COMMIT_SHA. Setiap push
// membuat deployment baru — SHA berubah → SEMUA session terhapus →
// semua user dipaksa login ulang hanya karena ada deploy, terlihat
// seperti "login loop" saat development (deploy beruntun).
//
// Deployment baru TIDAK lagi mematikan session. Ganti versi HANYA
// dengan menaikkan APP_VERSION di Vercel → saat itu semua session
// versi lama ter-invalidate (satu kali logout, by design).
// ============================================================

export const APP_VERSION = process.env.APP_VERSION || 'dev';
