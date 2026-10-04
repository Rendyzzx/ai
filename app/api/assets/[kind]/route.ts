/* ============================================================
   Aomi — app/api/assets/[kind]/route.ts
   Proxy penyajian asset situs (character / login banner).
   Repo storage private → browser tidak bisa akses langsung;
   route ini membaca binary server-side dan menyajikannya.

   Cache strategy: URL selalu membawa versi (?v=<content hash>) yang
   digenerate oleh pemakai URL (bukan route ini) → browser & CDN boleh
   cache PERMANEN. Upload baru = URL baru = cache baru; URL lama tidak
   pernah berubah isinya. Bukan cache-busting per render.

   Route ini TIDAK digerbang maintenance — asset harus tetap muat
   saat halaman maintenance aktif (maintenance page memakai asset ini).
   ============================================================ */

import { NextResponse } from "next/server";
import { readAssetBytes, type AssetKind } from "@/lib/server/siteassets";

export const dynamic = "force-dynamic";

const KINDS: Record<string, AssetKind> = {
  character: "character",
  "login-banner": "loginBanner",
  "login-banner-mobile": "loginBannerMobile",
};

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ kind: string }> }
) {
  const { kind } = await params;
  const assetKind = KINDS[kind];
  if (!assetKind) {
    return NextResponse.json({ error: "Aset tidak dikenal." }, { status: 404 });
  }

  try {
    const asset = await readAssetBytes(assetKind);
    if (!asset) {
      return NextResponse.json({ error: "Aset belum diunggah." }, {
        status: 404,
        headers: { "Cache-Control": "no-store" },
      });
    }
    return new Response(asset.data as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": asset.contentType,
        "Content-Length": String(asset.data.length),
        // v (content hash) ada di URL → cache permanen aman
        "Cache-Control": "public, max-age=31536000, s-maxage=31536000, immutable",
      },
    });
  } catch {
    return NextResponse.json({ error: "Aset tidak bisa dibaca." }, {
      status: 502,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
