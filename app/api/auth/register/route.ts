// ============================================================
// POST /api/auth/register
// Body: { username, email, password, captchaToken, captchaAnswer }
// Sukses: buat user + session (auto login), session id di body.
// Port dari api/auth/register.js — behavior identik.
// ============================================================

import crypto from "node:crypto";
import { readJson, putJson, updateJson } from "@/lib/server/store";
import { maintenanceBlockResponse } from "@/lib/server/maintenance";
import { allowIp, securityLog, clientIp } from "@/lib/server/ratelimit";
import {
  hashPassword,
  validateCredentials,
  verifyCaptcha,
  createSession,
} from "@/lib/server/auth";
import { json, methodNotAllowed, readBody } from "@/lib/server/http";

export const dynamic = "force-dynamic";

interface UserIndex {
  emails?: Record<string, string>;
  usernames?: Record<string, string>;
}

export async function POST(req: Request) {
  const maintGate = await maintenanceBlockResponse();
  if (maintGate) return maintGate;

  const ip = clientIp(req.headers);
  if (!allowIp("register", req, 5, 10 * 60 * 1000)) {
    return json({ error: "Terlalu banyak percobaan. Coba lagi nanti." }, 429);
  }

  const b = await readBody(req);
  const username = String(b.username || "").trim();
  const email = String(b.email || "").trim().toLowerCase();
  const password = b.password;

  if (!verifyCaptcha(b.captchaToken, b.captchaAnswer)) {
    return json({ error: "Jawaban verifikasi salah atau kedaluwarsa." }, 400);
  }

  const errors = validateCredentials(username, email, password);
  if (errors.length) return json({ error: errors[0] }, 400);

  // Cek duplikat lewat indeks (tidak memuat seluruh user)
  const index = await readJson<UserIndex>("users/_index.json");
  const idx = index?.data || { emails: {}, usernames: {} };
  if (idx.emails?.[email]) return json({ error: "Email sudah terdaftar." }, 409);
  if (idx.usernames?.[username.toLowerCase()]) {
    return json({ error: "Username sudah dipakai." }, 409);
  }

  const userId = crypto.randomUUID();
  const user = {
    id: userId,
    username,
    email,
    password_hash: hashPassword(password as string),
    created_at: new Date().toISOString(),
  };

  await putJson(`users/${userId}.json`, user, "user create");

  // Perbarui indeks dengan retry saat race
  await updateJson<UserIndex>("users/_index.json", "user index", (current) => {
    const data = current || { emails: {}, usernames: {} };
    data.emails = data.emails || {};
    data.usernames = data.usernames || {};
    data.emails[email] = userId;
    data.usernames[username.toLowerCase()] = userId;
    return data;
  });

  // Auto login setelah register: session id di body (bukan cookie)
  let session;
  try {
    session = await createSession(userId, true);
  } catch {
    return json(
      { error: "Akun dibuat, tapi sesi gagal dibuat. Silakan masuk." },
      500
    );
  }
  return json(
    {
      session_id: session.session_id,
      expires_at: session.expires_at,
      user: { id: userId, username, email },
    },
    201
  );
}

export async function GET() {
  return methodNotAllowed("POST");
}
