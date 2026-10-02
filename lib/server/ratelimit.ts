/* ============================================================
   Aomi — lib/server/ratelimit.ts
   Rate limiter in-memory (best-effort per instance; di belakang
   load balancer serverless ini membatasi burst per-instance,
   lapisan pertama dari beberapa lapisan pertahanan).

   Prinsip:
   - Endpoint dengan session: kunci limit pakai USER ID (akurat
     per akun, tidak bisa di-bypass ganti IP, dan user lain yang
     kebetulan se-NAT tidak ikut kena).
   - Endpoint publik / pre-auth: kunci IP + header konteks.
   - Event rate-limit dicatat sebagai security log terstruktur
     (endpoint + uid/ip + waktu) untuk deteksi pola abuse — TANPA
     isi pesan/kredensial.
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

/**
 * Security log terstruktur — hanya sinyal abuse, tanpa data privat.
 * (password, token, isi chat TIDAK PERNAH dilewat ke sini)
 */
export function securityLog(event: string, fields: Record<string, unknown>): void {
  try {
    console.warn(
      JSON.stringify({
        sec: event,
        at: new Date().toISOString(),
        ...fields,
      })
    );
  } catch {
    /* logging tidak boleh menjatuhkan request */
  }
}

/** Kunci limit untuk endpoint ber-session: per USER, IP hanya konteks. */
export function userLimitKey(scope: string, uid: string, req: Request): string {
  return `${scope}:u:${uid}|${clientIp(req.headers)}`;
}

/**
 * Cek limit untuk user terautentikasi. Saat limit terlampaui, catat
 * RATE_LIMIT_EXCEEDED dan kembalikan false.
 */
export function allowUser(
  scope: string,
  uid: string,
  req: Request,
  max: number,
  windowMs: number
): boolean {
  const ok = allow(userLimitKey(scope, uid, req), max, windowMs);
  if (!ok) {
    securityLog("RATE_LIMIT_EXCEEDED", { scope, uid, ip: clientIp(req.headers) });
  }
  return ok;
}

/**
 * Cek limit untuk endpoint publik/pre-auth (kunci IP).
 * Juga mencatat bila terlampaui.
 */
export function allowIp(
  scope: string,
  req: Request,
  max: number,
  windowMs: number
): boolean {
  const ip = clientIp(req.headers);
  const ok = allow(`${scope}:ip:${ip}`, max, windowMs);
  if (!ok) {
    securityLog("RATE_LIMIT_EXCEEDED", { scope, ip });
  }
  return ok;
}
