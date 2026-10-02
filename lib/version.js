// ============================================================
// Aomi — api/lib/version.js
// Application version: berubah otomatis setiap deployment.
// Dipakai untuk memvalidasi session lintas versi: session yang
// dibuat pada deploy lama dianggap tidak valid setelah deploy
// baru (user diminta login ulang) → UI/state lama tidak pernah
// dipakai bersama backend baru.
// ============================================================

// APP_VERSION bisa di-set manual (env Vercel), jika tidak otomatis
// mengikuti SHA commit deployment (tersedia otomatis di Vercel).
export const APP_VERSION =
  process.env.APP_VERSION ||
  (process.env.VERCEL_GIT_COMMIT_SHA
    ? process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 12)
    : 'local-dev');
