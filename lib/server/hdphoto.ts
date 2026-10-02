/* ============================================================
   Aomi — lib/server/hdphoto.ts
   Upscale foto ke HD lewat API faa (hdv4):
     GET https://api-faa.my.id/faa/hdv4?image=<url publik>
     → { status, result: { image_upscaled: <url> } }
   Sinkron (terukur ±7 detik) → aman dipanggil dari server.
   Input harus berupa URL publik (gambar dihosting dulu lewat
   /api/tempimg, pola sama seperti edit foto).
   ============================================================ */

const HDV4_API = "https://api-faa.my.id/faa/hdv4";
const TIMEOUT_MS = 50_000;
const RESULT_RE = /^https:\/\/[a-z0-9.-]+\/[A-Za-z0-9._/-]+$/i;

export class HdPhotoError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Ambil URL hasil upscale (image_upscaled) dari API hdv4. */
export async function upscalePhoto(imageUrl: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${HDV4_API}?image=${encodeURIComponent(imageUrl)}`, {
      signal: ctrl.signal,
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/131.0.0.0" },
    });
    const out = (await res.json().catch(() => null)) as {
      status?: boolean;
      result?: { image_upscaled?: string };
      error?: string;
    } | null;
    if (!res.ok || !out?.status || !out.result?.image_upscaled) {
      throw new HdPhotoError(
        "UPSTREAM",
        "hdv4 balas " + res.status + ": " + (out?.error || "tanpa hasil")
      );
    }
    const url = out.result.image_upscaled;
    if (!RESULT_RE.test(url)) throw new HdPhotoError("BADURL", "URL hasil tidak valid");
    return url;
  } catch (err) {
    if (err instanceof HdPhotoError) throw err;
    throw new HdPhotoError("NETWORK", "Tidak bisa menghubungi layanan upscale");
  } finally {
    clearTimeout(timer);
  }
}

/** Unduh bytes hasil upscale (dengan cap, anti respons raksasa). */
export async function fetchUpscaledBytes(
  url: string,
  maxBytes: number
): Promise<{ buffer: Buffer; mime: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/131.0.0.0" },
    });
    if (!res.ok) throw new HdPhotoError("HTTP_" + res.status, "hasil upscale " + res.status);
    const mime = (res.headers.get("content-type") || "").split(";")[0].trim();
    if (!/^image\//i.test(mime)) {
      throw new HdPhotoError("BADTYPE", "hasil bukan gambar: " + mime);
    }
    const len = Number(res.headers.get("content-length") || 0);
    if (len && len > maxBytes) {
      throw new HdPhotoError("TOOBIG", "hasil upscale melebihi batas");
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0 || buffer.length > maxBytes) {
      throw new HdPhotoError("TOOBIG", "hasil upscale melebihi batas");
    }
    return { buffer, mime };
  } catch (err) {
    if (err instanceof HdPhotoError) throw err;
    throw new HdPhotoError("NETWORK", "Gagal mengunduh hasil upscale");
  } finally {
    clearTimeout(timer);
  }
}
