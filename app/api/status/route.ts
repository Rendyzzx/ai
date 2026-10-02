// ============================================================
// Aomi — /api/status (Route Handler)
// Status sistem PUBLIK untuk landing page. Hanya data yang BENAR
// dan AMAN ditampilkan ke publik:
// - api: status diri endpoint ini (kalau kamu bisa baca respons
//   ini, API jelas jalan)
// - database: hasil PING sungguhan ke Upstash/GitHub (readJson key
//   yang sengaja tidak ada → null tanpa efek samping) + latency terukur
// - ai: hasil CEK LIVE ke endpoint Gemini (fetch cookie sungguhan,
//   time-boxed 4 detik) — di-cache 5 menit per instance supaya
//   endpoint publik tidak membuat server memukul Google di setiap
//   request. Klaim "operational" hanya kalau cek beneran berhasil.
// - version: dari APP_VERSION (env), tidak pernah dari SHA commit
// TIDAK ADA: CPU/RAM/uptime buatan — platform serverless Vercel
// tidak memberi metrik itu per instance, jadi tidak ditampilkan.
// Tidak ada secret/kredensial/host internal yang di-expose.
// ============================================================

import { json } from "@/lib/server/http";
import { allowIp, clientIp } from "@/lib/server/ratelimit";
import { readJson, USE_REDIS } from "@/lib/server/store";
import { APP_VERSION } from "@/lib/server/version";

export const dynamic = "force-dynamic";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Cache hasil cek AI: satu cek nyata per 5 menit per instance. */
let aiCheckCache: { ok: boolean; at: number } | null = null;

async function checkAiReachable(): Promise<boolean> {
  if (aiCheckCache && Date.now() - aiCheckCache.at < 5 * 60_000) {
    return aiCheckCache.ok;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  let ok = false;
  try {
    // Cek reachability provider AI yang sama dengan yang dipakai chat:
    // batchexecute Gemini harus membalas session cookie → berarti
    // provider benar-benar bisa dihubungi SEKARANG, bukan sekadar
    // "ada konfigurasinya".
    const res = await fetch(
      "https://gemini.google.com/_/BardChatUi/data/batchexecute" +
        "?rpcids=maGuAc&source-path=%2F&bl=boq_assistant-bard-web-server_20250814.06_p1" +
        "&f.sid=-7816331052118000090&hl=en-US&_reqid=173780&rt=c",
      {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
          "user-agent": UA,
        },
        body: "f.req=%5B%5B%5B%22maGuAc%22%2C%22%5B0%5D%22%2Cnull%2C%22generic%22%5D%5D%5D&",
      }
    );
    const cookies = res.headers.getSetCookie?.() || [];
    ok = Boolean((cookies[0] || "").split("; ")[0]);
  } catch {
    ok = false; // timeout / jaringan gagal → JANGAN klaim online
  } finally {
    clearTimeout(timer);
    aiCheckCache = { ok, at: Date.now() };
  }
  return ok;
}

export async function GET(req: Request) {
  // Publik tanpa login → rate limit per IP agar tidak disalahgunakan
  // untuk membebani ping database / cek AI.
  const ip = clientIp(req.headers);
  if (!allowIp("status", req, 30, 60_000)) {
    return json({ error: "Terlalu banyak permintaan. Coba lagi sebentar." }, 429);
  }

  const dbStart = Date.now();
  let dbOk = true;
  try {
    // Key yang sengaja tidak pernah dibuat — hanya untuk mengukur round-trip
    // nyata ke Upstash/GitHub, tanpa membaca/menulis data pengguna.
    await readJson("status/_healthcheck.json");
  } catch {
    dbOk = false;
  }
  const dbLatencyMs = Date.now() - dbStart;

  const aiOk = await checkAiReachable();

  const payload = {
    status: dbOk && aiOk ? "operational" : "degraded",
    checked_at: new Date().toISOString(),
    version: APP_VERSION,
    services: {
      api: "operational", // endpoint ini sendiri — sudah terbukti jalan
      database: dbOk ? "operational" : "down",
      ai: aiOk ? "operational" : "down",
    },
    database: {
      provider: USE_REDIS ? "Upstash Redis" : "GitHub (fallback)",
      latency_ms: dbLatencyMs,
    },
  };

  return json(payload);
}

export async function POST() {
  return json({ error: "Method tidak diizinkan" }, 405);
}
