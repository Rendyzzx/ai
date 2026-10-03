/* ============================================================
   Aomi — /api/maintenance-check (Route Handler)
   Endpoint PUBLIK ringan untuk middleware: apakah maintenance
   sedang berlaku. Dipakai middleware saat mode fallback GitHub
   (tanpa env Upstash). Tidak ada data lain yang dibocorkan.
   ============================================================ */

import { json } from "@/lib/server/http";
import { allowIp } from "@/lib/server/ratelimit";
import { isMaintenanceActive } from "@/lib/server/maintenance";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!allowIp("maintcheck", req, 120, 60_000)) {
    return json({ error: "Terlalu banyak permintaan." }, 429);
  }
  let active = false;
  try {
    active = await isMaintenanceActive();
  } catch {
    active = false; // fail open: storage error tidak boleh mematikan situs
  }
  return json({ active });
}

export async function POST() {
  return json({ error: "Method tidak diizinkan" }, 405);
}
