/* ============================================================
   Aomi — lib/server/telegram-auth.ts
   Login via Telegram bot + OTP (server-side, tanpa OAuth palsu).

   Flow:
   1. Web: POST /api/auth/telegram/start → attempt dibuat
      (id acak 192-bit, TTL 15 menit). Attempt TIDAK berisi OTP —
      OTP baru lahir setelah user membuka bot.
   2. User tekan "Buka Telegram" → t.me/<bot>?start=auth_<attemptId>
      → webhook mem-bind telegram user id ke attempt → bot mengirim
      OTP 6 digit (crypto.randomInt), disimpan HANYA sebagai hash,
      berlaku 5 menit, satu kali pakai.
   3. Web: POST /api/auth/telegram/verify {attempt_id, code} →
      server cek hash (timing-safe), expiry, attempt count, rate
      limit → sukses = attempt dihapus + session dibuat / akun
      ditautkan.

   Keamanan:
   - OTP tidak pernah plaintext di storage; hash = sha256(pepper :
     attemptId : otp) → hash tidak reusable lintas attempt.
   - One-time use: attempt dihapus setelah sukses.
   - Max 5 percobaan salah → attempt dikunci (dihapus).
   - Resend: cooldown 60 detik, max 3 kali, OTP lama ter-ganti.
   - Rate limit per IP di semua endpoint.
   - Identitas = Telegram user ID (bukan username).
   - Data internal (hash, counter, user id) tidak pernah dikirim
     ke client. Client hanya melihat attempt id (bukan credential).
   ============================================================ */

import crypto from "node:crypto";
import { readJson, putJson, expireJson, deleteJson } from "./store";
import { allowIp } from "./ratelimit";
import { sendMessage } from "@/lib/telegram/api";
import { createSession } from "./auth";
import {
  UserIndex,
  UserRecord,
  findUserByProvider,
  linkProviderToUser,
  createProviderUser,
} from "./oauth";
import {
  TG_OTP_RULES,
  tgOtpHash,
  tgOtpEqual,
  tgNewOtp,
} from "./tg-otp";

const ATTEMPT_TTL_S = TG_OTP_RULES.attemptTtlS;
const OTP_TTL_S = TG_OTP_RULES.otpTtlS;
const OTP_MAX_VERIFY = TG_OTP_RULES.maxVerify;
const RESEND_COOLDOWN_S = TG_OTP_RULES.resendCooldownS;
const RESEND_MAX = TG_OTP_RULES.resendMax;

const SITE = process.env.NEXT_PUBLIC_SITE_URL || "https://cyronime.web.id";

export interface TgAuthAttempt {
  id: string;
  created_at: number;
  expires_at: number;
  tg_user_id: number | null;
  tg_name: string | null;
  otp_hash: string | null;
  otp_expires_at: number | null;
  verify_attempts: number;
  resend_count: number;
  last_sent_at: number;
  used_at: number | null;
  link_user_id: string | null; // diisi bila flow link dari Pengaturan
}

const attemptPath = (id: string) => `auth/telegram/attempts/${id}.json`;

function pepper(): string {
  const s = process.env.SESSION_SECRET || process.env.GITHUB_TOKEN;
  if (!s) throw new Error("SESSION_SECRET / GITHUB_TOKEN belum diset");
  return s;
}

/** Hash OTP terikat attempt → hash bocor pun tak bisa dipakai di attempt lain. */
function otpHash(attemptId: string, code: string): string {
  return tgOtpHash(pepper(), attemptId, code);
}

function newOtp(): string {
  return tgNewOtp(); // crypto-secure 6 digit
}

// ---------------- Attempt lifecycle ----------------

export interface StartResult {
  ok: boolean;
  status: number;
  error?: string;
  attempt?: { id: string; expires_in: number };
}

/** Buat attempt baru (web). Mode link: user sudah login & menautkan dari Settings. */
export async function startAttempt(req: Request, linkUserId: string | null): Promise<StartResult> {
  if (!allowIp("tgauth-start", req, 10, 10 * 60_000)) {
    return { ok: false, status: 429, error: "Terlalu banyak percobaan. Coba lagi nanti." };
  }
  const id = crypto.randomBytes(24).toString("base64url");
  const now = Date.now();
  const attempt: TgAuthAttempt = {
    id,
    created_at: now,
    expires_at: now + ATTEMPT_TTL_S * 1000,
    tg_user_id: null,
    tg_name: null,
    otp_hash: null,
    otp_expires_at: null,
    verify_attempts: 0,
    resend_count: 0,
    last_sent_at: 0,
    used_at: null,
    link_user_id: linkUserId,
  };
  await putJson(attemptPath(id), attempt, "tg auth attempt");
  await expireJson(attemptPath(id), ATTEMPT_TTL_S);
  return { ok: true, status: 200, attempt: { id, expires_in: ATTEMPT_TTL_S } };
}

// ---------------- Bot side (webhook) ----------------

async function readAttempt(id: string): Promise<TgAuthAttempt | null> {
  const file = await readJson<TgAuthAttempt>(attemptPath(id));
  return file?.data || null;
}

/** Kirim OTP ke Telegram user terikat attempt (ganti OTP lama). */
async function sendOtp(attempt: TgAuthAttempt, tgUserId: number): Promise<void> {
  const code = newOtp();
  const now = Date.now();
  attempt.otp_hash = otpHash(attempt.id, code);
  attempt.otp_expires_at = now + OTP_TTL_S * 1000;
  attempt.last_sent_at = now;
  await putJson(attemptPath(attempt.id), attempt, "tg auth otp");
  await expireJson(attemptPath(attempt.id), ATTEMPT_TTL_S);

  await sendMessage(tgUserId, [
    "Kode login Aomi kamu:",
    "",
    `<b>${code}</b>`,
    "",
    "Berlaku 5 menit. Jangan bagikan kode ini ke siapa pun — termasuk yang mengaku dari tim Aomi.",
  ].join("\n"), {
    inline_keyboard: [[{ text: "Buka Aomi", url: `${SITE}/auth?tg=${attempt.id}` }]],
  });
}

const HOW_TO_LOGIN = [
  "Untuk masuk ke Aomi:",
  "1. Buka Aomi dan pilih \u201cLanjut dengan Telegram\u201d",
  "2. Tekan tombol \u201cBuka Telegram\u201d di halaman itu",
  "3. Kode login akan dikirim ke sini",
].join("\n");

export interface TgFrom { id: number; first_name?: string; username?: string }

/**
 * Handler update auth di bot (dipanggil webhook untuk /start auth_...
 * dan /login, admin maupun bukan). Pesan error tidak membocorkan
 * detail internal.
 */
export async function handleAuthUpdate(chatId: number, from: TgFrom, text: string): Promise<void> {
  const trimmed = (text || "").trim();

  // /start auth_<attemptId> — deep link dari halaman login
  const m = trimmed.match(/^\/start\s+auth_([A-Za-z0-9_-]{10,64})$/);
  if (m) {
    const attempt = await readAttempt(m[1]);
    if (!attempt || attempt.used_at) {
      await sendMessage(chatId, "Permintaan login tidak ditemukan atau sudah kedaluwarsa. Buka ulang halaman login Aomi.");
      return;
    }
    if (attempt.expires_at < Date.now()) {
      await deleteJson(attemptPath(attempt.id)).catch(() => {});
      await sendMessage(chatId, "Permintaan login sudah kedaluwarsa. Buka ulang halaman login Aomi.");
      return;
    }
    if (attempt.tg_user_id && attempt.tg_user_id !== from.id) {
      // Attempt ini sedang dipakai perangkat/orang lain — jangan bocorkan siapa.
      await sendMessage(chatId, "Permintaan login ini sedang dipakai di tempat lain. Mulai ulang dari halaman login Aomi.");
      return;
    }
    if (attempt.tg_user_id === from.id) {
      // User menekan start dua kali → kirim ulang OTP (resend via bot dihitung cooldown)
      if (Date.now() - attempt.last_sent_at < RESEND_COOLDOWN_S * 1000) {
        await sendMessage(chatId, "Kode terakhir masih berlaku. Cek pesan sebelumnya.");
        return;
      }
    }
    attempt.tg_user_id = from.id;
    attempt.tg_name = from.first_name || from.username || "tg";
    attempt.resend_count = 0;
    await sendOtp(attempt, from.id);
    return;
  }

  // /login — entry dari bot: buat attempt di sisi bot, user kembali via tombol
  if (trimmed === "/login" || trimmed === "/login@AomiBot") {
    const start = await startAttemptForBot(from);
    await sendMessage(chatId, [
      "Permintaan login Aomi diterima.",
      "",
      "Kode sedang dikirim — tekan tombol di bawah untuk kembali ke Aomi.",
    ].join("\n"), {
      inline_keyboard: [[{ text: "Buka Aomi", url: `${SITE}/auth?tg=${start.id}` }]],
    });
    await sendOtp(start, from.id);
    return;
  }

  // /start polos / bantuan
  await sendMessage(chatId, HOW_TO_LOGIN);
}

/** Attempt untuk entry /login dari bot: langsung bind ke Telegram user. */
async function startAttemptForBot(from: TgFrom): Promise<TgAuthAttempt> {
  const id = crypto.randomBytes(24).toString("base64url");
  const now = Date.now();
  const attempt: TgAuthAttempt = {
    id,
    created_at: now,
    expires_at: now + ATTEMPT_TTL_S * 1000,
    tg_user_id: from.id,
    tg_name: from.first_name || from.username || "tg",
    otp_hash: null,
    otp_expires_at: null,
    verify_attempts: 0,
    resend_count: 0,
    last_sent_at: 0,
    used_at: null,
    link_user_id: null,
  };
  await putJson(attemptPath(id), attempt, "tg auth attempt");
  await expireJson(attemptPath(id), ATTEMPT_TTL_S);
  return attempt;
}

// ---------------- Web verify / resend ----------------

export interface VerifyResult {
  ok: boolean;
  status: number;
  error?: string;
  session?: { session_id: string; expires_at: number };
  linked?: boolean;
}

async function genericFail(attempt: TgAuthAttempt): Promise<VerifyResult> {
  attempt.verify_attempts += 1;
  if (attempt.verify_attempts >= OTP_MAX_VERIFY) {
    await deleteJson(attemptPath(attempt.id)).catch(() => {});
    return { ok: false, status: 429, error: "Terlalu banyak percobaan. Mulai ulang dari awal." };
  }
  await putJson(attemptPath(attempt.id), attempt, "tg auth fail");
  return { ok: false, status: 400, error: "Kode salah atau kedaluwarsa." };
}

/** Verifikasi OTP dari web → login / register / link. */
export async function verifyAttempt(req: Request, attemptId: string, code: string): Promise<VerifyResult> {
  if (!allowIp("tgauth-verify", req, 15, 10 * 60_000)) {
    return { ok: false, status: 429, error: "Terlalu banyak percobaan. Coba lagi nanti." };
  }
  const attempt = await readAttempt(attemptId);
  if (!attempt || attempt.used_at) {
    return { ok: false, status: 400, error: "Kode salah atau kedaluwarsa." };
  }
  if (attempt.expires_at < Date.now()) {
    await deleteJson(attemptPath(attemptId)).catch(() => {});
    return { ok: false, status: 400, error: "Permintaan login kedaluwarsa. Mulai ulang." };
  }
  // Belum pernah buka bot → tidak ada OTP sama sekali
  if (!attempt.tg_user_id || !attempt.otp_hash || !attempt.otp_expires_at) {
    return { ok: false, status: 400, error: "Belum ada kode. Buka bot Telegram dulu lewat tombol Buka Telegram." };
  }
  if (attempt.otp_expires_at < Date.now()) {
    return { ok: false, status: 400, error: "Kode sudah kedaluwarsa. Kirim ulang kode." };
  }

  // Bandingkan hash timing-safe
  if (!tgOtpEqual(attempt.otp_hash, attemptId, code, pepper())) {
    return await genericFail(attempt);
  }

  // Sukses → one-time use: hapus SEBELUM membuat session (anti replay race)
  attempt.used_at = Date.now();
  await deleteJson(attemptPath(attemptId)).catch(() => {});

  const tgId = attempt.tg_user_id;

  // Mode link (dari Pengaturan): tautkan ke user yang sedang login
  if (attempt.link_user_id) {
    const existing = await findUserByProvider("telegram", tgId);
    if (existing && existing !== attempt.link_user_id) {
      return { ok: false, status: 409, error: "Telegram ini sudah terhubung ke akun lain." };
    }
    const linked = await linkProviderToUser(attempt.link_user_id, "telegram", tgId);
    if (!linked) return { ok: false, status: 500, error: "Gagal menghubungkan. Coba lagi." };
    return { ok: true, status: 200, linked: true };
  }

  // Login: cari by Telegram user ID
  let userId = await findUserByProvider("telegram", tgId);

  // Belum ada → daftar akun baru (identitas: Telegram user ID)
  if (!userId) {
    userId = await createProviderUser("telegram", tgId, attempt.tg_name || "tg", null);
  }

  try {
    const session = await createSession(userId, true);
    return { ok: true, status: 200, session: { session_id: session.session_id, expires_at: session.expires_at } };
  } catch {
    return { ok: false, status: 500, error: "Sesi gagal dibuat. Coba lagi sebentar." };
  }
}

/** Kirim ulang OTP (web). Cooldown + max resend. */
export async function resendAttempt(req: Request, attemptId: string): Promise<VerifyResult> {
  if (!allowIp("tgauth-resend", req, 10, 10 * 60_000)) {
    return { ok: false, status: 429, error: "Terlalu banyak percobaan. Coba lagi nanti." };
  }
  const attempt = await readAttempt(attemptId);
  if (!attempt || attempt.used_at) {
    return { ok: false, status: 400, error: "Permintaan login tidak ditemukan. Mulai ulang." };
  }
  if (attempt.expires_at < Date.now()) {
    await deleteJson(attemptPath(attemptId)).catch(() => {});
    return { ok: false, status: 400, error: "Permintaan login kedaluwarsa. Mulai ulang." };
  }
  if (!attempt.tg_user_id) {
    return { ok: false, status: 400, error: "Belum ada kode. Buka bot Telegram dulu lewat tombol Buka Telegram." };
  }
  if (Date.now() - attempt.last_sent_at < RESEND_COOLDOWN_S * 1000) {
    return { ok: false, status: 429, error: "Tunggu sebentar sebelum meminta kode lagi." };
  }
  if (attempt.resend_count >= RESEND_MAX) {
    await deleteJson(attemptPath(attemptId)).catch(() => {});
    return { ok: false, status: 429, error: "Batas kirim kode tercapai. Mulai ulang dari awal." };
  }
  attempt.resend_count += 1;
  await sendOtp(attempt, attempt.tg_user_id);
  return { ok: true, status: 200 };
}

/** Username bot untuk deep link (cache 10 menit). */
export async function getBotUsername(): Promise<string | null> {
  try {
    const t = process.env.TELEGRAM_BOT_TOKEN;
    if (!t) return null;
    const res = await fetch(`https://api.telegram.org/bot${t}/getMe`, { cache: "no-store" });
    if (!res.ok) return null;
    const out = (await res.json()) as { ok?: boolean; result?: { username?: string } };
    return out.ok && out.result?.username ? out.result.username : null;
  } catch {
    return null;
  }
}
