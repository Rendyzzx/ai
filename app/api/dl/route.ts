// ============================================================
// Aomi — /api/dl (Route Handler)
// Proxy unduh media TikTok (video MP4 / audio MP3 / foto slide).
// Anchor <a> tidak bisa kirim header X-Session-Id → session boleh
// lewat ?sid=. Allowlist hostname KETAT (anti SSRF).
// Port dari api/dl.js — behavior identik.
// ============================================================

import { getSession } from "@/lib/server/auth";
import { maintenanceBlockResponse } from "@/lib/server/maintenance";
import { getFlags } from "@/lib/server/features";
import { allowUser } from "@/lib/server/ratelimit";

export const dynamic = "force-dynamic";

// Hanya CDN TikTok yang boleh di-proxy
const ALLOWED_HOSTS = [
  /^([a-z0-9-]+\.)?tiktokcdn\.com$/i,
  /^([a-z0-9-]+\.)?tiktokcdn-us\.com$/i,
  /^([a-z0-9-]+\.)?tiktokcdn-eu\.com$/i,
  /^([a-z0-9-]+\.)?tiktok\.com$/i,
  /^([a-z0-9-]+\.)?byteoversea\.com$/i,
];

const MAX_BYTES = 30_000_000; // ~30MB cap buffer unduhan
const MAX_SECONDS = 60;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  // Session: dari header (fetch klien) atau ?sid= (link unduh anchor)
  const sid = String(searchParams.get("sid") || "");
  const sessionHeaders = /^[a-f0-9]{64}$/.test(sid)
    ? new Headers({ "x-session-id": sid })
    : req.headers;
  const session = await getSession(sessionHeaders);
  if (!session) {
    return Response.json(
      { error: "Sesi berakhir. Login ulang dulu ya.", code: "SESSION_INVALID" },
      { status: 401 }
    );
  }

  const maintGate = await maintenanceBlockResponse();
  if (maintGate) return maintGate;
  const featureFlags = await getFlags();
  if (!featureFlags.dl) return Response.json({ error: "Fitur downloader sedang dinonaktifkan sementara oleh admin." }, { status: 503 });

  if (!allowUser("dl", session.user_id, req, 15, 60_000)) {
    return Response.json({ error: "Terlalu banyak unduhan. Tunggu sebentar." }, { status: 429 });
  }

  // Validasi URL target (allowlist hostname, wajib https)
  let target: URL;
  try {
    target = new URL(String(searchParams.get("url") || ""));
  } catch {
    return Response.json({ error: "URL tidak valid" }, { status: 400 });
  }
  if (target.protocol !== "https:" || !ALLOWED_HOSTS.some((re) => re.test(target.hostname))) {
    return Response.json({ error: "Sumber unduhan tidak diizinkan" }, { status: 400 });
  }

  // Nama file rapi (anti header injection)
  let name = String(searchParams.get("name") || "");
  if (!/^[a-z0-9 ._()-]{1,64}$/i.test(name)) name = "aomi-download.mp4";

  // Ambil dari CDN
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MAX_SECONDS * 1000);
  let upstream: Response;
  try {
    upstream = await fetch(target.href, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0" },
    });
  } catch {
    return Response.json(
      { error: "Gagal mengambil file (timeout). Linknya mungkin sudah kedaluwarsa — kirim ulang linknya ya." },
      { status: 504 }
    );
  } finally {
    clearTimeout(timer);
  }

  if (!upstream.ok || !upstream.body) {
    return Response.json(
      { error: "Link unduhan sudah kedaluwarsa. Kirim ulang linknya ya." },
      { status: 502 }
    );
  }

  const len = Number(upstream.headers.get("content-length") || 0);
  if (len > MAX_BYTES) {
    return Response.json(
      { error: "Filenya terlalu besar untuk diunduh lewat sini." },
      { status: 413 }
    );
  }

  const buf = Buffer.from(await upstream.arrayBuffer());
  if (!buf.length) {
    return Response.json({ error: "File kosong. Coba lagi ya." }, { status: 502 });
  }
  if (buf.length > MAX_BYTES) {
    return Response.json(
      { error: "Filenya terlalu besar untuk diunduh lewat sini." },
      { status: 413 }
    );
  }

  // Content-type dari upstream — whitelist dasar
  let mime = String(upstream.headers.get("content-type") || "").split(";")[0].trim();
  if (!/^(video|audio|image)\//.test(mime)) mime = "application/octet-stream";

  const headers = new Headers();
  headers.set("Content-Type", mime);
  headers.set("Content-Length", String(buf.length));
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Disposition", `attachment; filename="${name}"`);
  headers.set("Cache-Control", "no-store");

  return new Response(new Uint8Array(buf), { headers });
}

export async function POST() {
  return Response.json({ error: "Method tidak diizinkan" }, { status: 405 });
}
