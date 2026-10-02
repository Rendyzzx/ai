/* ============================================================
   Aomi — lib/server/http.ts
   Helper kecil untuk Route Handler (App Router) biar response
   konsisten: no-store, JSON, parse body.
   ============================================================ */

import { NextResponse } from "next/server";

export function json(data: unknown, status = 200): NextResponse {
  const res = NextResponse.json(data, { status });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export function methodNotAllowed(allow: string): NextResponse {
  const res = NextResponse.json({ error: "Method tidak diizinkan" }, { status: 405 });
  res.headers.set("Allow", allow);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

/** Parse body JSON dengan toleransi (null saat kosong/rusak). */
export async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
