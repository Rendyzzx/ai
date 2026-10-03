/* ============================================================
   Aomi — lib/server/siteassets.ts
   Asset visual situs yang bisa diganti admin lewat bot Telegram
   (character maintenance page + login banner) TANPA deploy ulang.

   Arsitektur (mengikuti aturan: binary tidak masuk Redis):
   - Binary gambar  → repo token Rendyzzx/token, path assets/site/*
   - Redis          → aomi:assets/state.json: reference saja
                      (storageKey, version hash, contentType, ukuran,
                      dimensi, siapa yang upload, kapan)
   - Penyajian      → /api/assets/<kind>?v=<version>  (proxy server-side
                      karena repo private; cache per-version permanen)
   - Version = sha256 konten → URL berubah hanya jika gambar berubah
     (asset tetap cacheable, tidak ada cache-busting per render).

   Fallback bila belum ada asset yang diupload: pakai character
   statis yang sudah ada di repo (/assets/auth-hero.png).
   ============================================================ */

import crypto from "node:crypto";
import { readJson, putJson } from "./store";
import { getBinary, putBinary, deleteBinary } from "./github";
import { KEYS } from "@/lib/redis/keys";
import { validateUpload, type AssetExt } from "./imagedata";

export type AssetKind = "character" | "loginBanner";

/** loginBanner = peekaboo (karakter di atas form "Selamat datang kembali"),
 *  BUKAN hero marketing di landing page. Satu upload dipakai utk kedua
 *  state peek (open/closed) — animasi tetap jalan, gambarnya sama. */
export const ASSET_KINDS: Record<AssetKind, { label: string; urlKind: string; fallback: string }> = {
  character: { label: "Character", urlKind: "character", fallback: "/assets/auth-hero.png" },
  loginBanner: { label: "Login Banner (peekaboo)", urlKind: "login-banner", fallback: "/assets/auth-banner-open.png" },
};

export interface AssetRecord {
  /** Ukuran file dalam byte. */
  size: number;
  storageKey: string;
  version: string;
  contentType: string;
  ext: AssetExt;
  width?: number;
  height?: number;
  updatedAt: string;
  uploadedBy: number;
}

interface SiteAssetsState {
  character?: AssetRecord | null;
  loginBanner?: AssetRecord | null;
}

/** Cache instance 30 detik — tulis selalu mem-bust cache. */
let cache: { state: SiteAssetsState; at: number } | null = null;
function bust() { cache = null; }

async function rawState(): Promise<SiteAssetsState> {
  const file = await readJson<SiteAssetsState>(KEYS.siteAssets);
  const data = file?.data;
  return data && typeof data === "object" ? (data as SiteAssetsState) : {};
}

async function getState(): Promise<SiteAssetsState> {
  if (cache && Date.now() - cache.at < 30_000) return cache.state;
  const state = await rawState();
  cache = { state, at: Date.now() };
  return state;
}

/** Akses record asset secara type-safe (kind = "character" | "loginBanner"). */
function recordOf(state: SiteAssetsState, kind: AssetKind): AssetRecord | null | undefined {
  return state[kind];
}

export interface AssetInfo {
  url: string;
  width: number;
  height: number;
  /** true jika masih memakai asset statis default (belum diupload admin). */
  isDefault: boolean;
}

/** Info untuk <Image> — selalu aman dipanggil (fallback statis). */
export async function getAssetInfo(kind: AssetKind): Promise<AssetInfo> {
  try {
    const state = await getState();
    const rec = recordOf(state, kind);
    if (rec) {
      return {
        url: `/api/assets/${ASSET_KINDS[kind].urlKind}?v=${rec.version}`,
        width: rec.width || 900,
        height: rec.height || 1120,
        isDefault: false,
      };
    }
  } catch {
    // fail open — pakai default statis
  }
  return { url: ASSET_KINDS[kind].fallback, width: 900, height: 1120, isDefault: true };
}

/** Bytes asset saat ini (untuk proxy /api/assets/* & preview bot). */
export async function readAssetBytes(
  kind: AssetKind
): Promise<(AssetRecord & { data: Uint8Array }) | null> {
  const rec = recordOf(await rawState(), kind);
  if (!rec) return null;
  const data = await getBinary(rec.storageKey);
  if (!data) return null;
  return { ...rec, data };
}

export interface SaveAssetInput {
  bytes: Uint8Array;
  width?: number;
  height?: number;
  uploadedBy: number;
}

/**
 * Validasi → simpan binary ke repo token → update reference Redis.
 * Throw Error dengan pesan ramah jika file tidak valid.
 */
export async function saveAsset(kind: AssetKind, input: SaveAssetInput): Promise<AssetRecord> {
  const img = validateUpload(input.bytes);
  const version = crypto.createHash("sha256").update(img.bytes).digest("hex").slice(0, 12);
  const storageKey = `assets/site/${ASSET_KINDS[kind].urlKind}-${version}.${img.ext}`;

  const ok = await putBinary(storageKey, img.bytes, `asset: set ${kind} (v${version})`);
  if (!ok) throw new Error("Gagal menyimpan file ke storage. Coba lagi.");

  const state = await rawState();
  const old = recordOf(state, kind);

  const rec: AssetRecord = {
    storageKey,
    version,
    contentType: img.contentType,
    ext: img.ext,
    size: img.bytes.length,
    ...(input.width && input.height ? { width: input.width, height: input.height } : {}),
    updatedAt: new Date().toISOString(),
    uploadedBy: input.uploadedBy,
  };

  await putJson(KEYS.siteAssets, { ...state, [kind]: rec });
  bust();

  // File lama dihapus best-effort — URL versi lama sudah tidak dipakai;
  // kegagalan hapus tidak menggagalkan upload baru.
  if (old && old.storageKey !== storageKey) {
    await deleteBinary(old.storageKey).catch(() => {});
  }

  return rec;
}

/** Hapus asset (kembali ke default statis). */
export async function deleteAsset(kind: AssetKind): Promise<boolean> {
  const state = await rawState();
  const rec = recordOf(state, kind);
  if (!rec) return false;
  await putJson(KEYS.siteAssets, { ...state, [kind]: null });
  bust();
  await deleteBinary(rec.storageKey).catch(() => {});
  return true;
}

/** Ringkasan state asset (untuk tampilan bot admin). */
export async function describeAsset(kind: AssetKind): Promise<string> {
  try {
    const rec = recordOf(await rawState(), kind);
    if (!rec) return "Belum ada upload — memakai asset default Aomi.";
    const dim = rec.width && rec.height ? `${rec.width}×${rec.height}px` : "dimensi tidak diketahui";
    const when = new Date(rec.updatedAt);
    const wib = new Intl.DateTimeFormat("id-ID", {
      timeZone: "Asia/Jakarta", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
    }).format(when);
    return [
      `Status: ✅ custom (v${rec.version.slice(0, 6)})`,
      `Format: ${rec.contentType}, ${(rec.size / 1_048_576).toFixed(2)} MB`,
      `Dimensi: ${dim}`,
      `Terakhir diubah: ${wib} WIB`,
    ].join("\n");
  } catch {
    return "Status tidak bisa dibaca (storage error).";
  }
}
