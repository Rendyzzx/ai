/* ============================================================
   Aomi — lib/server/tg-otp.ts
   Logika OTP login Telegram yang murni (tanpa import storage/API)
   supaya bisa dites unit test (npm test) — node type-stripping.
   Dipakai lib/server/telegram-auth.ts.
   ============================================================ */

import crypto from "node:crypto";

/** Batasan keamanan OTP — satu sumber kebenaran. */
export const TG_OTP_RULES = {
  attemptTtlS: 15 * 60, // attempt hidup 15 menit
  otpTtlS: 5 * 60, // kode berlaku 5 menit
  maxVerify: 5, // max percobaan salah per attempt
  resendCooldownS: 60, // jeda kirim ulang
  resendMax: 3, // max kirim ulang per attempt
  codeLength: 6,
} as const;

/** Attempt id valid (base64url 10-64 karakter). */
export function tgAttemptIdValid(id: string): boolean {
  return /^[A-Za-z0-9_-]{10,64}$/.test(id);
}

/** Format kode OTP: tepat 6 digit. */
export function tgCodeValid(code: string): boolean {
  return /^\d{6}$/.test(code);
}

/**
 * Hash OTP terikat attempt — hash yang bocor tidak bisa dipakai
 * di attempt lain. Timing-safe di pembanding (telegram-auth).
 */
export function tgOtpHash(pepper: string, attemptId: string, code: string): string {
  return crypto
    .createHash("sha256")
    .update(`${pepper}:tg-otp:${attemptId}:${code}`)
    .digest("hex");
}

/** Bandingkan hash OTP timing-safe. */
export function tgOtpEqual(storedHex: string, attemptId: string, code: string, pepper: string): boolean {
  const given = Buffer.from(tgOtpHash(pepper, attemptId, code), "hex");
  const stored = Buffer.from(storedHex, "hex");
  if (stored.length !== given.length || stored.length === 0) return false;
  return crypto.timingSafeEqual(stored, given);
}

/** OTP baru — cryptographically secure, selalu 6 digit tanpa leading nol hilang. */
export function tgNewOtp(): string {
  return String(crypto.randomInt(100000, 1000000));
}
