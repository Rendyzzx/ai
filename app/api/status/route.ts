// ============================================================
// Aomi — /api/status (Route Handler)
// Status sistem PUBLIK untuk landing page. Hanya data yang BENAR
// dan AMAN ditampilkan ke publik:
// - platform/runtime: fakta deployment (Vercel + Next.js)
// - region: dari process.env.VERCEL_REGION (runtime nyata, bukan karangan)
// - version: dari APP_VERSION (env), tidak pernah dari SHA commit
// - database: hasil PING sungguhan ke Upstash/GitHub (readJson key
//   yang sengaja tidak ada → null tanpa efek samping) + latency terukur
// - ai_provider: status KONFIGURASI (bukan live-call ke Gemini — call
//   sungguhan mahal/lambat untuk endpoint publik tanpa auth), diberi
//   label jujur "Terkonfigurasi"/"Belum dikonfigurasi", bukan "Operational"
//   palsu.
// TIDAK ADA: CPU/RAM/uptime-persentase buatan — platform serverless
// Vercel tidak memberi metrik itu per instance, jadi tidak ditampilkan.
// ============================================================

import { json } from "@/lib/server/http";
import { allow, clientIp } from "@/lib/server/ratelimit";
import { readJson, USE_REDIS } from "@/lib/server/store";
import { APP_VERSION } from "@/lib/server/version";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // Publik tanpa login → rate limit per IP agar tidak disalahgunakan
  // untuk membebani ping database.
  const ip = clientIp(req.headers);
  if (!allow("status:" + ip, 30, 60_000)) {
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

  // Provider Gemini tidak butuh API key statis (sesi diambil otomatis
  // saat chat pertama) — jadi "configured" selalu true di sini, bukan
  // live-test (lihat komentar header kenapa live-call tidak dilakukan).
  const aiConfigured = true;

  const payload = {
    status: dbOk ? "operational" : "degraded",
    checked_at: new Date().toISOString(),
    platform: process.env.VERCEL ? "Vercel" : "Node.js",
    runtime: "Next.js 15 (App Router)",
    region: process.env.VERCEL_REGION || "lokal",
    version: APP_VERSION,
    database: {
      provider: USE_REDIS ? "Upstash Redis" : "GitHub (fallback)",
      status: dbOk ? "up" : "down",
      latency_ms: dbLatencyMs,
    },
    ai_provider: {
      name: "Gemini",
      configured: aiConfigured,
    },
  };

  return json(payload);
}

export async function POST() {
  return json({ error: "Method tidak diizinkan" }, 405);
}
