// GET /api/auth/captcha → soal verifikasi manusia (token terenkripsi)

import { makeCaptcha } from "@/lib/server/auth";
import { json, methodNotAllowed } from "@/lib/server/http";
import { allowIp } from "@/lib/server/ratelimit";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // Dibatasi per IP — endpoint pre-auth gratis, jangan jadi sumber spam.
  if (!allowIp("captcha", req, 30, 60_000)) {
    return json({ error: "Terlalu banyak permintaan." }, 429);
  }
  const c = makeCaptcha();
  return json({ number: c.number, token: c.token });
}

export async function POST() {
  return methodNotAllowed("GET");
}
