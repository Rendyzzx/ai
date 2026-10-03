// ============================================================
// Aomi — /api/hd (Route Handler)
// Dukungan fitur HD video:
//   GET ?action=poll&job=<job_id>
//       → JSON { state, download_url?, quality? } — dipakai kartu HD
//         di chat untuk polling job sampai "done".
//   GET ?action=dl&job=<job_id>[&name=][&sid=]
//       → cek hasil job, proxy file video sebagai unduhan
//         (Content-Disposition: attachment).
//
// Anchor <a> tidak bisa kirim header X-Session-Id → session boleh
// lewat ?sid=. Allowlist hostname KETAT (anti SSRF), pola sama
// dengan /api/dl dan /api/music.
// ============================================================

import { getSession } from "@/lib/server/auth";
import { maintenanceBlockResponse } from "@/lib/server/maintenance";
import { getFlags } from "@/lib/server/features";
import { allowUser } from "@/lib/server/ratelimit";
import { pollHdJob, HD_RESULT_HOSTS, HD_JOB_RE, HdError } from "@/lib/server/hdvid";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BYTES = 80_000_000; // video HD lebih besar dari klip — cap 80MB
const MAX_SECONDS = 55;

function errorJson(message: string, status: number): Response {
  const res = Response.json({ error: message }, { status });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const action = String(searchParams.get("action") || "");
  const job = String(searchParams.get("job") || "");

  // Session: dari header (fetch klien) atau ?sid= (link unduh anchor)
  const sid = String(searchParams.get("sid") || "");
  const sessionHeaders = /^[a-f0-9]{64}$/.test(sid)
    ? new Headers({ "x-session-id": sid })
    : req.headers;
  const session = await getSession(sessionHeaders);
  if (!session) {
    return errorJson("Sesi berakhir. Login ulang dulu ya.", 401);
  }

  const maintGate = await maintenanceBlockResponse();
  if (maintGate) return maintGate;
  const featureFlags = await getFlags();
  if (!featureFlags.hd) return errorJson("Fitur HD sedang dinonaktifkan sementara oleh admin.", 503);

  if (!HD_JOB_RE.test(job)) {
    return errorJson("ID job HD tidak valid.", 400);
  }

  // ---------------- Poll: status job untuk kartu di chat ----------------
  if (action === "poll") {
    if (!allowUser("hdpoll", session.user_id, req, 40, 60_000)) {
      return errorJson("Terlalu banyak permintaan. Tunggu sebentar.", 429);
    }
    try {
      const out = await pollHdJob(job);
      const res = Response.json({
        state: out.state,
        ...(out.download_url ? { download_url: out.download_url } : {}),
        ...(out.quality ? { quality: out.quality } : {}),
      });
      res.headers.set("Cache-Control", "no-store");
      return res;
    } catch (err) {
      const code = err instanceof HdError ? err.code : "UPSTREAM";
      return errorJson(
        code === "NETWORK" ? "Layanan HD tidak bisa dihubungi." : "Gagal cek job HD.",
        502
      );
    }
  }

  // ---------------- DL: proxy video HD sebagai file unduhan ----------------
  if (action === "dl") {
    if (!allowUser("hddl", session.user_id, req, 10, 60_000)) {
      return errorJson("Terlalu banyak unduhan. Tunggu sebentar.", 429);
    }

    let target: URL;
    try {
      const out = await pollHdJob(job);
      if (out.state !== "done" || !out.download_url) {
        return errorJson("Videonya masih diproses / hasilnya gak tersedia.", 409);
      }
      target = new URL(out.download_url);
    } catch {
      return errorJson("Gagal mengambil hasil HD. Coba lagi ya.", 502);
    }

    if (target.protocol !== "https:" || !HD_RESULT_HOSTS.some((re) => re.test(target.hostname))) {
      return errorJson("Sumber unduhan tidak diizinkan", 400);
    }

    // Nama file rapi (anti header injection) — fallback dari ?name=
    let name = String(searchParams.get("name") || "");
    if (!/^[a-z0-9 ._()-]{1,64}$/i.test(name)) name = "aomi-hd.mp4";
    if (!/\.mp4$/i.test(name)) name += ".mp4";

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), MAX_SECONDS * 1000);
    let upstream: Response;
    try {
      upstream = await fetch(target.href, { signal: ctrl.signal });
    } catch {
      return errorJson("Gagal mengambil file (timeout). Coba lagi ya.", 504);
    } finally {
      clearTimeout(timer);
    }

    if (!upstream.ok || !upstream.body) {
      return errorJson("File hasil HD gagal diambil. Coba lagi ya.", 502);
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

    const headers = new Headers();
    headers.set("Content-Type", "video/mp4");
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
