// ============================================================
// Aomi — /api/tempimg (Route Handler)
// Host gambar SEMENTARA dengan URL publik (input edit foto via
// API eksternal + hasil edit dengan masa unduh 3 hari).
// Port dari api/tempimg.js — behavior identik.
// ============================================================

import { readJson } from "@/lib/server/store";

export const dynamic = "force-dynamic";

const ALLOWED_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const ID_RE = /^[a-z0-9-]{8,64}$/;

interface TempImgRecord {
  b64: string;
  mime: string;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = String(searchParams.get("id") || "");
  if (!ID_RE.test(id)) {
    return Response.json({ error: "ID tidak valid" }, { status: 400 });
  }

  const file = await readJson<TempImgRecord>(`tempimg/${id}.json`);
  const rec = file?.data;
  if (!rec || typeof rec.b64 !== "string" || !ALLOWED_MIME.includes(rec.mime)) {
    return Response.json({ error: "Gambar tidak ditemukan / sudah kedaluwarsa" }, { status: 404 });
  }

  let buf: Buffer;
  try {
    buf = Buffer.from(rec.b64, "base64");
  } catch {
    return Response.json({ error: "Gambar tidak valid" }, { status: 404 });
  }
  if (!buf.length) return Response.json({ error: "Gambar kosong" }, { status: 404 });

  const headers = new Headers();
  headers.set("Content-Type", rec.mime);
  headers.set("Content-Length", String(buf.length));
  // Live selama masa sewa key Redis; browser boleh cache 1 jam.
  headers.set("Cache-Control", "public, max-age=3600");

  // Mode unduhan: nama file rapi
  if (searchParams.get("dl") === "1") {
    let name = String(searchParams.get("name") || "");
    if (!/^[a-z0-9._-]{1,64}$/i.test(name)) {
      name = "aomi-edit." + (rec.mime === "image/png" ? "png" : "jpg");
    }
    headers.set("Content-Disposition", `attachment; filename="${name}"`);
  }

  return new Response(new Uint8Array(buf), { headers });
}

export async function POST() {
  return Response.json({ error: "Method tidak diizinkan" }, { status: 405 });
}
