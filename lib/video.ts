/* ============================================================
   Aomi — lib/video.ts (client)
   Dukungan upload video di chat:
   - uploadVideo(): pecah file jadi chunk base64 → /api/vupload
     (server merakit lalu menghosting di uguu.se) → URL publik.
   - extractVideoFrames(): ambil beberapa frame video lewat
     <video> + <canvas> → JPEG dataURL. Frame-frame ini jadi
     "mata" AI vision untuk video (upload video langsung ke
     Gemini butuh akun login, jadi frame yang dikirim).
   ============================================================ */

import { apiJson } from "./client-api";

const VIDEO_MAX_BYTES = 50 * 1024 * 1024;
const VIDEO_MIME_RE = /^video\/(mp4|webm|quicktime|x-matroska|3gpp|avi)$/i;
const FRAME_COUNT = 6;
const FRAME_MAX = 640;

export function isVideoFile(file: File): boolean {
  return VIDEO_MIME_RE.test(file.type) || /\.(mp4|webm|mov|mkv|3gp|avi)$/i.test(file.name);
}

/**
 * Upload video ke hosting lewat server (uguu CORS tertutup).
 * Chunk base64 dikirim berurutan dengan laporan progres 0..1.
 * Return: URL publik video.
 */
export async function uploadVideo(
  file: File,
  onProgress?: (ratio: number) => void
): Promise<string> {
  if (!isVideoFile(file)) throw new Error("Format video ini tidak didukung. Pakai MP4 ya.");
  if (file.size > VIDEO_MAX_BYTES) throw new Error("Video maksimal 50MB ya.");

  const init = await apiJson<{ upload_id: string; chunk_bytes: number }>("/api/vupload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "init", name: file.name, mime: file.type, size: file.size }),
  });

  // Baca file per slice → base64 (tanpa FileReader, lebih cepat)
  const chunkBytes = init.chunk_bytes;
  const total = Math.ceil(file.size / chunkBytes);
  let offset = 0;
  let index = 0;
  while (offset < file.size) {
    const slice = file.slice(offset, Math.min(offset + chunkBytes, file.size));
    const buf = await slice.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buf);
    const STEP = 0x8000;
    for (let i = 0; i < bytes.length; i += STEP) {
      binary += String.fromCharCode(...bytes.subarray(i, i + STEP));
    }
    await apiJson("/api/vupload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "chunk",
        upload_id: init.upload_id,
        index,
        data: btoa(binary),
      }),
    });
    offset += chunkBytes;
    index += 1;
    onProgress?.(Math.min(1, offset / file.size));
  }

  const finish = await apiJson<{ url: string }>("/api/vupload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "finish", upload_id: init.upload_id, total }),
  });
  return finish.url;
}

/**
 * Ambil frame dari video (seek merata + canvas). Return: frame
 * dataURL JPEG (maks FRAME_COUNT) + frame pertama sebagai poster.
 * Gagal (codec aneh dsb) → { frames: [], poster: null }.
 */
export async function extractVideoFrames(
  file: File
): Promise<{ frames: string[]; poster: string | null }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = url;

    const cleanup = () => {
      video.removeAttribute("src");
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* abaikan */
      }
    };
    const fail = () => {
      cleanup();
      resolve({ frames: [], poster: null });
    };

    let safety: ReturnType<typeof setTimeout>;
    safety = setTimeout(fail, 30_000);

    video.onloadedmetadata = () => {
      const duration = video.duration;
      if (!Number.isFinite(duration) || duration <= 0) return fail();
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) return fail();

      const drawFrame = (): string | null => {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (!w || !h) return null;
        const scale = Math.min(1, FRAME_MAX / Math.max(w, h));
        canvas.width = Math.max(2, Math.round(w * scale));
        canvas.height = Math.max(2, Math.round(h * scale));
        try {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          return canvas.toDataURL("image/jpeg", 0.72);
        } catch {
          return null;
        }
      };

      const frames: string[] = [];
      let i = 0;
      const seekNext = () => {
        if (i >= FRAME_COUNT) {
          clearTimeout(safety);
          const poster = frames.length ? frames[0] : null;
          cleanup();
          resolve({ frames, poster });
          return;
        }
        // merata: 8%..92% durasi
        const t = duration * (0.08 + (0.84 * i) / Math.max(1, FRAME_COUNT - 1));
        i += 1;
        video.onseeked = () => {
          const f = drawFrame();
          if (f) frames.push(f);
          seekNext();
        };
        video.onerror = fail;
        try {
          video.currentTime = Math.min(t, Math.max(0, duration - 0.05));
        } catch {
          seekNext();
        }
      };
      seekNext();
    };
    video.onerror = fail;
  });
}
