// ============================================================
// POST /api/auth/login
// Body: { identifier, password, remember, captchaToken, captchaAnswer }
// Anti brute force: lock 15 menit setelah 5 kegagalan (persist storage).
// Port dari api/auth/login.js — behavior identik.
// ============================================================

import { readJson } from "@/lib/server/store";
import { maintenanceBlockResponse } from "@/lib/server/maintenance";
import { allowIp, securityLog, clientIp } from "@/lib/server/ratelimit";
import {
  verifyPassword,
  verifyCaptcha,
  createSession,
  getLoginLock,
  recordLoginFail,
  clearLoginLock,
} from "@/lib/server/auth";
import { isUserSuspended } from "@/lib/server/adminsvc";
import { json, methodNotAllowed, readBody } from "@/lib/server/http";

export const dynamic = "force-dynamic";

const GENERIC_FAIL = "Email/username atau password salah.";

export async function POST(req: Request) {
  const maintGate = await maintenanceBlockResponse();
  if (maintGate) return maintGate;

  const ip = clientIp(req.headers);
  if (!allowIp("login", req, 10, 60 * 1000)) {
    return json({ error: "Terlalu banyak percobaan. Coba lagi nanti." }, 429);
  }

  const b = await readBody(req);
  const identifier = String(b.identifier || "").trim().toLowerCase();
  const remember = Boolean(b.remember);

  if (!verifyCaptcha(b.captchaToken, b.captchaAnswer)) {
    return json({ error: "Jawaban verifikasi salah atau kedaluwarsa." }, 400);
  }

  // Terkunci sementara?
  const lock = await getLoginLock(identifier, ip);
  if (lock) {
    const mins = Math.ceil((lock.locked_until - Date.now()) / 60000);
    return json(
      { error: `Terlalu banyak percobaan gagal. Coba lagi dalam ${mins} menit.` },
      429
    );
  }

  const fail = async (status = 401) => {
    const locked = await recordLoginFail(identifier, ip);
    if (locked) {
      return json(
        { error: "Terlalu banyak percobaan gagal. Akun terkunci 15 menit." },
        429
      );
    }
    return json({ error: GENERIC_FAIL }, status);
  };

  if (!identifier || typeof b.password !== "string") return fail(400);

  // Cari user via indeks (tanpa memuat semua user)
  const index = await readJson<{ emails?: Record<string, string>; usernames?: Record<string, string> }>("users/_index.json");
  const idx = index?.data || {};
  const userId = idx.emails?.[identifier] || idx.usernames?.[identifier];
  if (!userId) return fail();

  const userFile = await readJson<{ id: string; username: string; email: string; password_hash: string }>(`users/${userId}.json`);
  if (!userFile) return fail();

  const user = userFile.data;
  if (!verifyPassword(b.password, user.password_hash)) return fail();
  if (await isUserSuspended(user.id)) {
    return json({ error: "Akun ini sedang dibekukan admin." }, 403);
  }

  // Sukses → bersihkan lock, buat session
  await clearLoginLock(identifier, ip);
  // Session id dikirim di body → client simpan di sessionStorage (bukan cookie).
  let session;
  try {
    session = await createSession(user.id, remember);
  } catch {
    // JANGAN jawab sukses bila session gagal tersimpan/terbaca.
    return json({ error: "Session gagal dibuat. Coba lagi sebentar." }, 500);
  }
  return json({
    session_id: session.session_id,
    expires_at: session.expires_at,
    user: { id: user.id, username: user.username, email: user.email },
  });
}

export async function GET() {
  return methodNotAllowed("POST");
}
