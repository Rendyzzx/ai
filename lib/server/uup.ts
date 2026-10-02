/* ============================================================
   Aomi — lib/server/uup.ts
   Upload file video ke uguu.se (hosting sementara, CORS tertutup
   jadi HARUS lewat server). Dipakai fitur upload video:
   client kirim potongan (chunk) ke /api/vupload, server rakit
   lalu dorong sekaligus ke uguu → URL publik dipakai untuk
   submit job HD (api-faa hdvid terbukti menerima URL uguu).
   - uguu: gratis, tanpa login, file hidup beberapa jam
   - field multipart: files[]
   - respons JSON: { files: [{ url }] }
   ============================================================ */

const UGUU_API = "https://uguu.se/upload?output=json";

/** Host hasil upload yang boleh dipakai (validasi di /api/chat). */
export const UPLOAD_HOST_RE = /^https:\/\/(?:[a-z0-9-]+\.)?uguu\.se\/[A-Za-z0-9._-]+$/i;

export class UupError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Upload bytes ke uguu.se → { url }. Timeout besar karena video
 * bisa puluhan MB (upload dipengaruhi bandwidth server).
 */
export async function uploadToUguu(
  bytes: Uint8Array,
  filename: string,
  mime: string,
  timeoutMs = 120_000
): Promise<{ url: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const form = new FormData();
    // nama file dirapikan — tanpa path/spasi, ekstensi asli dipertahankan
    const safe = filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80) || "video.mp4";
    form.append("files[]", new Blob([bytes as unknown as BlobPart], { type: mime || "video/mp4" }), safe);

    const res = await fetch(UGUU_API, {
      method: "POST",
      body: form,
      signal: ctrl.signal,
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/131.0.0.0" },
    });
    if (!res.ok) throw new UupError("HTTP_" + res.status, "Host upload balas " + res.status);
    const out = (await res.json()) as { success?: boolean; files?: Array<{ url?: string }> };
    const url = out?.files?.[0]?.url;
    if (!out?.success || !url || !/^https:\/\//.test(url)) {
      throw new UupError("BADRESP", "Host upload balas tanpa URL");
    }
    return { url };
  } catch (err) {
    if (err instanceof UupError) throw err;
    throw new UupError("NETWORK", "Host upload tidak bisa dihubungi");
  } finally {
    clearTimeout(timer);
  }
}
