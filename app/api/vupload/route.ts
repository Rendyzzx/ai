/* ============================================================
   Aomi — /api/vupload (Route Handler)
   Upload video dari browser → hosting sementara (uguu.se).
   Uguu tidak mengirim header CORS, jadi browser tidak bisa
   upload langsung; server jadi perantara. Batas body Vercel
   ±4.5MB per request → file dipecah chunk base64:

     POST { action: "init",   name, mime, size }
       → { upload_id, chunk_bytes }
     POST { action: "chunk",  upload_id, index, data }   (data: base64)
       → { received }
     POST { action: "finish", upload_id, total }
       → { url }   (URL publik uguu, dipakai HD / preview chat)

   Chunk disimpan di store (Redis / fallback) dengan TTL 1 jam;
   dihapus begitu finish (sukses maupun gagal).
   ============================================================ */

import crypto from "node:crypto";
import { getSession } from "@/lib/server/auth";
import { allowIp, allowUser } from "@/lib/server/ratelimit";
import { readJson, putJson, deleteJson, expireJson } from "@/lib/server/store";
import { uploadToUguu, UupError } from "@/lib/server/uup";
import { json, methodNotAllowed, readBody } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Batas video: 50MB — muat untuk klip pendek, masih masuk akal
// di koneksi seluler, dan aman untuk rakit di memori fungsi.
const VIDEO_MAX = 50 * 1024 * 1024;
const CHUNK_B64 = 2_600_000; // ±1.95MB biner per chunk (jauh di bawah limit body)
const CHUNK_MAX = 64; // 64 × 1.95MB ≈ 125MB > cap 50MB
const TTL_SECONDS = 60 * 60;
const VIDEO_MIME_RE = /^video\/(mp4|webm|quicktime|x-matroska|3gpp|avi)$/i;
const NAME_RE = /^[A-Za-z0-9 _.\-()]{1,80}$/;

interface UploadMeta {
  name: string;
  mime: string;
  size: number;
  created: number;
}

interface ChunkFile {
  data: string;
}

export async function POST(req: Request) {
  const session = await getSession(req.headers);
  if (!session) return json({ error: "Sesi berakhir. Login ulang dulu ya." }, 401);

  const body = await readBody(req);
  const action = String(body.action || "");

  // ---------------- INIT ----------------
  if (action === "init") {
    if (!allowUser("vupload", session.user_id, req, 8, 10 * 60_000)) {
      return json({ error: "Terlalu banyak upload. Tunggu sebentar ya." }, 429);
    }
    const name = String(body.name || "");
    const mime = String(body.mime || "").toLowerCase();
    const size = Number(body.size) || 0;
    if (!NAME_RE.test(name) || !VIDEO_MIME_RE.test(mime)) {
      return json({ error: "Jenis file video ini tidak didukung. Pakai MP4 biar paling aman." }, 400);
    }
    if (!Number.isFinite(size) || size < 1000 || size > VIDEO_MAX) {
      return json({ error: "Ukuran video harus antara 1KB dan 50MB." }, 400);
    }

    const uploadId = crypto.randomUUID();
    const meta: UploadMeta = { name, mime, size, created: Date.now() };
    await putJson(`vupload/${uploadId}/meta.json`, meta, "vupload init");
    await expireJson(`vupload/${uploadId}/meta.json`, TTL_SECONDS);
    return json({ upload_id: uploadId, chunk_bytes: CHUNK_B64 });
  }

  // ---------------- CHUNK ----------------
  if (action === "chunk") {
    if (!allowIp("vchunk", req, 300, 10 * 60_000)) {
      return json({ error: "Upload terlalu cepat. Tunggu sebentar." }, 429);
    }
    const uploadId = String(body.upload_id || "");
    const index = Number(body.index);
    const data = String(body.data || "");
    if (!/^[a-f0-9-]{36}$/.test(uploadId)) return json({ error: "ID upload tidak valid." }, 400);
    if (!Number.isInteger(index) || index < 0 || index >= CHUNK_MAX) {
      return json({ error: "Nomor chunk tidak valid." }, 400);
    }
    if (data.length === 0 || data.length > CHUNK_B64 || !/^[A-Za-z0-9+/=]+$/.test(data)) {
      return json({ error: "Data chunk tidak valid." }, 400);
    }

    const meta = await readJson<UploadMeta>(`vupload/${uploadId}/meta.json`);
    if (!meta) return json({ error: "Upload kedaluwarsa. Coba ulangi." }, 404);

    const path = `vupload/${uploadId}/${index}.json`;
    await putJson(path, { data } satisfies ChunkFile, "vupload chunk");
    await expireJson(path, TTL_SECONDS);
    return json({ received: index });
  }

  // ---------------- FINISH ----------------
  if (action === "finish") {
    if (!allowUser("vfinish", session.user_id, req, 8, 10 * 60_000)) {
      return json({ error: "Terlalu banyak upload. Tunggu sebentar ya." }, 429);
    }
    const uploadId = String(body.upload_id || "");
    const total = Number(body.total);
    if (!/^[a-f0-9-]{36}$/.test(uploadId)) return json({ error: "ID upload tidak valid." }, 400);
    if (!Number.isInteger(total) || total < 1 || total > CHUNK_MAX) {
      return json({ error: "Jumlah chunk tidak valid." }, 400);
    }

    const metaFile = await readJson<UploadMeta>(`vupload/${uploadId}/meta.json`);
    if (!metaFile || !metaFile.data) return json({ error: "Upload kedaluwarsa. Coba ulangi." }, 404);
    const meta = metaFile.data;

    // Rakit chunk (paralel biar cepat, lalu gabung urut)
    const paths: string[] = [];
    for (let i = 0; i < total; i++) paths.push(`vupload/${uploadId}/${i}.json`);
    const chunks = await Promise.all(paths.map((p) => readJson<ChunkFile>(p)));
    for (let i = 0; i < total; i++) {
      if (!chunks[i] || typeof chunks[i]!.data.data !== "string") {
        await cleanup(uploadId, total);
        return json({ error: "Ada potongan video yang hilang. Coba ulangi." }, 400);
      }
    }
    const bytes = Buffer.concat(
      chunks.map((c) => Buffer.from(c!.data.data, "base64"))
    );
    await cleanup(uploadId, total);

    if (bytes.length === 0 || bytes.length !== meta.size) {
      return json({ error: "Video tidak utuh saat diterima. Coba ulangi." }, 400);
    }

    try {
      const out = await uploadToUguu(bytes, meta.name, meta.mime);
      return json({ url: out.url });
    } catch (err) {
      const code = err instanceof UupError ? err.code : "UPSTREAM";
      console.error("[vupload] uguu gagal (" + code + "):", (err as Error).message);
      return json({ error: "Gagal mengunggah video ke hosting. Coba lagi ya." }, 502);
    }
  }

  return methodNotAllowed("POST");
}

/** Hapus meta + semua chunk (best effort). */
async function cleanup(uploadId: string, total: number) {
  try {
    await deleteJson(`vupload/${uploadId}/meta.json`);
    for (let i = 0; i < total; i++) {
      await deleteJson(`vupload/${uploadId}/${i}.json`);
    }
  } catch {
    /* best effort — TTL 1 jam pasti kehapus juga */
  }
}
