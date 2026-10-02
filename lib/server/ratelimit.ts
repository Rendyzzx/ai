/* ============================================================
   Aomi — lib/server/ratelimit.ts
   Rate limiter in-memory (best-effort per instance).
   Port dari lib/ratelimit.js.
   ============================================================ */

const hits = new Map<string, number[]>();

/** true jika aksi BOLEH dilanjutkan, false jika melewati batas. */
export function allow(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    hits.set(key, arr);
    return false;
  }
  arr.push(now);
  hits.set(key, arr);
  if (hits.size > 5000) hits.clear();
  return true;
}

/** IP klien dari header proxy (Vercel selalu set XFF). */
export function clientIp(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for");
  return (typeof fwd === "string" ? fwd.split(",")[0].trim() : "") || "anon";
}
