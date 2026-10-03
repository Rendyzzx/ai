/* ============================================================
   Aomi — lib/server/limits.ts
   Limit operasional (dipakai app/api/chat + ditampilkan read-only
   di menu Configuration bot).
   ============================================================ */

export const LIMITS = {
  rateWindowMs: 60_000,
  rateMax: 20,
  messageMaxLen: 4000,
  promptMaxLen: 1000,
  responseMaxLen: 8000,
  fetchBytes: 100_000,
  geminiTimeout: 25_000,
  maxMessages: 100,
  contextSend: 8,
  downloadTimeout: 30_000,
  tempInputTtl: 3600,
  tempResultTtl: 259_200,
  editResultMax: 10_000_000,
} as const;
