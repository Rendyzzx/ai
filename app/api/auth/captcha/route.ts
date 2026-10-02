// GET /api/auth/captcha → soal verifikasi manusia (token terenkripsi)

import { makeCaptcha } from "@/lib/server/auth";
import { json, methodNotAllowed } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export async function GET() {
  const c = makeCaptcha();
  return json({ number: c.number, token: c.token });
}

export async function POST() {
  return methodNotAllowed("GET");
}
