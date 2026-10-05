/* ============================================================
   Aomi — lib/server/dl-platforms.ts
   Matcher URL → platform downloader tambahan (non-TikTok/IG).
   Modul PURE (tanpa import) supaya bisa di-unit-test oleh
   scripts/test-downloader.mjs dengan node type-stripping.
   ============================================================ */

export type DlPlatform =
  | "twitter"
  | "facebook"
  | "spotify"
  | "soundcloud"
  | "bandcamp"
  | "pinterest"
  | "threads"
  | "bilibili"
  | "pixiv"
  | "rednote"
  | "reddit"
  | "terabox"
  | "mediafire"
  | "sfile"
  | "sub2unlock";

/** Hostname (di-normalkan: tanpa www., lowercase) → platform. */
const HOST_RULES: Array<[RegExp, DlPlatform]> = [
  [/(^|\.)twitter\.com$/, "twitter"],
  [/(^|\.)x\.com$/, "twitter"],
  [/(^|\.)facebook\.com$/, "facebook"],
  [/(^|\.)fb\.watch$/, "facebook"], // short link resmi Facebook (video)
  [/(^|\.)fb\.me$/, "facebook"], // short link resmi Facebook
  [/(^|\.)open\.spotify\.com$/, "spotify"],
  [/(^|\.)spotify\.com$/, "spotify"],
  [/(^|\.)soundcloud\.com$/, "soundcloud"],
  [/(^|\.)bandcamp\.com$/, "bandcamp"],
  [/(^|\.)pinterest\.com$/, "pinterest"],
  [/(^|\.)pin\.it$/, "pinterest"], // short link resmi Pinterest
  [/(^|\.)threads\.net$/, "threads"],
  [/(^|\.)threads\.com$/, "threads"],
  [/(^|\.)bilibili\.com$/, "bilibili"],
  [/(^|\.)bilibili\.tv$/, "bilibili"],
  [/(^|\.)b23\.tv$/, "bilibili"], // short link resmi Bilibili
  [/(^|\.)pixiv\.net$/, "pixiv"],
  [/(^|\.)rednote\.com$/, "rednote"],
  [/(^|\.)xiaohongshu\.com$/, "rednote"],
  [/(^|\.)reddit\.com$/, "reddit"],
  [/(^|\.)redd\.it$/, "reddit"], // short link resmi Reddit
  [/(^|\.)terabox\.com$/, "terabox"],
  [/(^|\.)teraboxapp\.com$/, "terabox"],
  [/(^|\.)1024tera\.com$/, "terabox"],
  [/(^|\.)mediafire\.com$/, "mediafire"],
  [/(^|\.)sfile\.co$/, "sfile"],
  [/(^|\.)sfile\.mobi$/, "sfile"],
  [/(^|\.)sub2unlock\.com$/, "sub2unlock"],
];

export function dlPlatformFromHost(host: string): DlPlatform | null {
  const h = String(host || "").replace(/^www\./i, "").toLowerCase();
  for (const [re, platform] of HOST_RULES) {
    if (re.test(h)) return platform;
  }
  return null;
}

/**
 * Balik { platform, url } bila teks berisi link platform tambahan,
 * selain itu null. Link pertama yang cocok yang menang — urutan
 * sama seperti penulisan di chat.
 */
export function matchExtraDlTarget(
  text: string
): { platform: DlPlatform; url: string } | null {
  const urls = String(text || "").match(/https?:\/\/[^\s<>"')\]]+/gi) || [];
  for (const raw of urls) {
    let u: URL;
    try {
      u = new URL(raw.replace(/[.,;!?]+$/, ""));
    } catch {
      continue;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") continue;
    const platform = dlPlatformFromHost(u.hostname);
    if (platform) return { platform, url: u.href };
  }
  return null;
}

/** Label tampil di badge kartu unduhan. */
export function dlPlatformLabel(platform: string): string {
  const labels: Record<string, string> = {
    tiktok: "TikTok",
    ig: "Instagram",
    twitter: "X (Twitter)",
    facebook: "Facebook",
    spotify: "Spotify",
    soundcloud: "SoundCloud",
    bandcamp: "Bandcamp",
    pinterest: "Pinterest",
    threads: "Threads",
    bilibili: "Bilibili",
    pixiv: "Pixiv",
    rednote: "RedNote",
    reddit: "Reddit",
    terabox: "TeraBox",
    mediafire: "MediaFire",
    sfile: "Sfile",
    sub2unlock: "Sub2Unlock",
  };
  return labels[platform] || platform;
}

/** Prefix nama file unduhan (dipakai tombol unduh proxy /api/dl). */
export function dlFilePrefix(platform: string): string {
  const map: Record<string, string> = {
    twitter: "twitter",
    facebook: "facebook",
    spotify: "spotify",
    soundcloud: "soundcloud",
    bandcamp: "bandcamp",
    pinterest: "pinterest",
    threads: "threads",
    bilibili: "bilibili",
    pixiv: "pixiv",
    rednote: "rednote",
    reddit: "reddit",
    terabox: "terabox",
    mediafire: "mediafire",
    sfile: "sfile",
    sub2unlock: "sub2unlock",
  };
  return map[platform] || "aomi";
}
