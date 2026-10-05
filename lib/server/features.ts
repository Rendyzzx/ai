/* ============================================================
   Aomi — lib/server/features.ts
   Feature flags — satu record JSON terstruktur, dicek DI SERVER
   (bukan cuma sembunyikan tombol). Cache pendek per instance.
   ============================================================ */

import { readJson, putJson } from "./store";
import { KEYS } from "@/lib/redis/keys";

export const FEATURE_NAMES = [
  "chat",
  "music",
  "image-edit",
  "imggen",
  "hd",
  "dl",
  "video",
  "pin",
  "bookmark",
  "search",
  "feedback",
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];
export type FeatureFlags = Record<FeatureName, boolean>;

export const DEFAULT_FLAGS: FeatureFlags = {
  chat: true,
  music: true,
  "image-edit": true,
  imggen: true,
  hd: true,
  dl: true,
  video: true,
  pin: true,
  bookmark: true,
  search: true,
  feedback: true,
};

const FLAG_LABELS: Record<FeatureName, string> = {
  chat: "Chat AI",
  music: "Musik (putar lagu)",
  "image-edit": "Edit foto",
  imggen: "Generate gambar AI",
  hd: "HD foto & video",
  dl: "Downloader media sosial & file",
  video: "Upload video + AI vision",
  pin: "Pin & arsip percakapan",
  bookmark: "Simpanan (bookmark jawaban)",
  search: "Pencarian isi percakapan",
  feedback: "Feedback jawaban (👍/👎)",
};

export function featureLabel(name: FeatureName): string {
  return FLAG_LABELS[name] || name;
}

let flagCache: { flags: FeatureFlags; at: number } | null = null;
const FLAG_CACHE_MS = 30_000;

export async function getFlags(): Promise<FeatureFlags> {
  if (flagCache && Date.now() - flagCache.at < FLAG_CACHE_MS) {
    return flagCache.flags;
  }
  const file = await readJson<{ values?: Partial<FeatureFlags> }>(KEYS.features).catch(() => null);
  const stored = (file?.data?.values || {}) as Partial<FeatureFlags>;
  const flags = { ...DEFAULT_FLAGS };
  for (const name of FEATURE_NAMES) {
    if (typeof stored[name] === "boolean") flags[name] = stored[name] as boolean;
  }
  flagCache = { flags, at: Date.now() };
  return flags;
}

/** Set satu flag. Return flag terbaru, atau null jika nama tidak valid. */
export async function setFlag(name: string, enabled: boolean): Promise<FeatureFlags | null> {
  if (!(FEATURE_NAMES as readonly string[]).includes(name)) return null;
  const current = await getFlags();
  const next = { ...current, [name]: enabled } as FeatureFlags;
  await putJson(KEYS.features, { values: next, updated_at: new Date().toISOString() }, "feature flag");
  flagCache = { flags: next, at: Date.now() };
  return next;
}

export function resetFlagCache(): void {
  flagCache = null;
}
