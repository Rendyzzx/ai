// ============================================================
// Aomi — /api/music (Route Handler)
// Dukungan fitur musik:
//   GET ?action=dl&id=<videoId>[&name=][&sid=]
//       → resolve audio baru dari savetube, proxy sebagai file
//         unduhan (Content-Disposition: attachment).
//   GET ?action=resolve&id=<videoId>
//       → JSON { audio_url, title } — dipakai player untuk refresh
//         link audio lama yang kedaluwarsa (riwayat lama).
//
// Anchor <a> tidak bisa kirim header X-Session-Id → session boleh
// lewat ?sid=. Allowlist hostname KETAT (anti SSRF), pola sama
// dengan /api/dl.
// ============================================================

import { getSession } from "@/lib/server/auth";
import { allowUser } from "@/lib/server/ratelimit";
import { savetubeAudio, MusicError } from "@/lib/server/music";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Hanya CDN savetube yang boleh di-proxy
const ALLOWED_HOSTS = [/^([a-z0-9-]+\.)?savetube\.(vip|me|pro)$/i];

const MAX_BYTES = 30_000_000; // ~30MB cap buffer unduhan
const MAX_SECONDS = 55;

function errorJson(message: string, status: number): Response {
  const res = Response.json({ error: message }, { status });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const action = String(searchParams.get("action") || "");
  const id = String(searchParams.get("id") || "");

  // Session: dari header (fetch klien) atau ?sid= (link unduh anchor)
  const sid = String(searchParams.get("sid") || "");
  const sessionHeaders = /^[a-f0-9]{64}$/.test(sid)
    ? new Headers({ "x-session-id": sid })
    : req.headers;
  const session = await getSession(sessionHeaders);
  if (!session) {
    return errorJson("Sesi berakhir. Login ulang dulu ya.", 401);
  }

  if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) {
    return errorJson("ID lagu tidak valid.", 400);
  }

  // ---------------- Resolve: link audio segar untuk player ----------------
  if (action === "resolve") {
    if (!allowUser("musicres", session.user_id, req, 20, 60_000)) {
      return errorJson("Terlalu banyak permintaan. Tunggu sebentar.", 429);
    }
    try {
      const st = await savetubeAudio(id, 2);
      const res = Response.json({ audio_url: st.audio_url, title: st.title });
      res.headers.set("Cache-Control", "no-store");
      return res;
    } catch (err) {
      const code = err instanceof MusicError ? err.code : "UPSTREAM";
      return errorJson(
        code === "NO_CONFIG"
          ? "Fitur musik belum dikonfigurasi di server."
          : "Gagal mengambil lagunya. Coba ulang pesannya ya.",
        code === "NO_CONFIG" ? 503 : 502
      );
    }
  }

  // ---------------- DL: proxy audio sebagai file unduhan ----------------
  if (action === "dl") {
    if (!allowUser("musicdl", session.user_id, req, 15, 60_000)) {
      return errorJson("Terlalu banyak unduhan. Tunggu sebentar.", 429);
    }

    let target: URL;
    try {
      const st = await savetubeAudio(id, 2);
      target = new URL(st.audio_url);
    } catch (err) {
      const code = err instanceof MusicError ? err.code : "UPSTREAM";
      return errorJson(
        code === "NO_CONFIG"
          ? "Fitur musik belum dikonfigurasi di server."
          : "Link unduhan lagu gagal dibuat. Coba lagi ya.",
        code === "NO_CONFIG" ? 503 : 502
      );
    }
    if (target.protocol !== "https:" || !ALLOWED_HOSTS.some((re) => re.test(target.hostname))) {
      return errorJson("Sumber unduhan tidak diizinkan", 400);
    }

    // Nama file rapi (anti header injection) — fallback dari ?name=
    let name = String(searchParams.get("name") || "");
    if (!/^[a-z0-9 ._()-]{1,64}$/i.test(name)) name = "aomi-music.m4a";

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), MAX_SECONDS * 1000);
    let upstream: Response;
    try {
      upstream = await fetch(target.href, {
        signal: ctrl.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36",
          Origin: "https://yt.savetube.me",
        },
      });
    } catch {
      return errorJson("Gagal mengambil file (timeout). Coba lagi ya.", 504);
    } finally {
      clearTimeout(timer);
    }

    if (!upstream.ok || !upstream.body) {
      return errorJson("Link unduhan lagu gagal diambil. Coba lagi ya.", 502);
    }

    const len = Number(upstream.headers.get("content-length") || 0);
    if (len > MAX_BYTES) {
      return errorJson("Filenya terlalu besar untuk diunduh lewat sini.", 413);
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    if (!buf.length) return errorJson("File kosong. Coba lagi ya.", 502);
    if (buf.length > MAX_BYTES) {
      return errorJson("Filenya terlalu besar untuk diunduh lewat sini.", 413);
    }

    // Content-type dari upstream — whitelist audio
    let mime = String(upstream.headers.get("content-type") || "").split(";")[0].trim();
    if (!/^audio\//.test(mime)) mime = "application/octet-stream";

    const headers = new Headers();
    headers.set("Content-Type", mime);
    headers.set("Content-Length", String(buf.length));
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Content-Disposition", `attachment; filename="${name}"`);
    headers.set("Cache-Control", "no-store");

    return new Response(new Uint8Array(buf), { headers });
  }

  return errorJson("Aksi tidak dikenal.", 400);
}

export async function POST() {
  return errorJson("Method tidak diizinkan", 405);
}
