/* ============================================================
   Aomi — lib/server/scrape.ts
   Downloader platform tambahan (selain TikTok/IG) via scrapr
   yang di-vendor di lib/vendor/scrapr. Semua method di sini sudah
   diuji: status true DAN link unduhannya benar bisa diakses.

   Kontrak: scrapeExtraDl(platform, url) → DlCard, atau throw
   ScrapeError dengan pesan siap-tampil ke pengguna.
   ============================================================ */

import type { DlCard } from "@/types";
import type { DlPlatform } from "./dl-platforms";

/* scrapr = CommonJS tanpa deklarasi tipe → require + bentuk minimal */
const scrapr = require("../vendor/scrapr") as ScraprApi;

type ScraprDownload = {
  url?: string;
  type?: string;
  quality?: string;
  filename?: string;
};
type ScraprResult = {
  title?: string | null;
  thumbnail?: string | null;
  type?: string | null;
  artist?: string | null;
  downloads?: ScraprDownload[];
  url?: string;
  filename?: string | null;
};
type ScraprFn = (
  url: string,
  opts?: unknown
) => Promise<{ status: boolean; result?: ScraprResult; message?: string }>;
type ScraprApi = Record<string, Record<string, ScraprFn>>;

export class ScrapeError extends Error {}

/** CDN tertentu hanya melayani http → paksa https (mis. rednotecdn). */
function httpsify(u: string | null | undefined): string | undefined {
  if (typeof u !== "string" || !/^https?:\/\//i.test(u)) return undefined;
  return u.replace(/^http:\/\//i, "https://");
}

function clip(v: unknown, max: number): string | undefined {
  const t = typeof v === "string" ? v.trim() : "";
  return t.slice(0, max) || undefined;
}

/** Ambil hanya URL unduhan yang valid. */
function dlUrls(r: ScraprResult): ScraprDownload[] {
  return (r.downloads || []).filter(
    (d) => typeof d.url === "string" && /^https?:\/\//i.test(d.url)
  );
}

/** Rantai fallback per platform — method pertama yang sukses menang. */
const METHOD_CHAIN: Record<string, string[]> = {
  twitter: ["direct", "tweeload", "tvd", "savetwt"],
  facebook: ["snapsave"],
  spotify: ["spotidown", "spotisaver", "spotmate", "soundloaders"],
  soundcloud: ["klickaud"],
  bandcamp: ["bandcampdownloader"],
  pinterest: ["direct", "pindown"],
  threads: ["threadster"],
  bilibili: ["direct"],
  pixiv: ["ajax"],
  rednote: ["direct"],
  reddit: ["rapidsave"],
  terabox: ["sechno"],
};

async function runChain(
  namespace: string,
  platform: string,
  url: string
): Promise<ScraprResult> {
  const group = scrapr[namespace];
  const methods = METHOD_CHAIN[platform] || [];
  let lastMessage = "";
  for (const m of methods) {
    const fn = group && group[m];
    if (!fn) continue;
    let res: { status: boolean; result?: ScraprResult; message?: string };
    try {
      res = await fn(url);
    } catch (e) {
      lastMessage = String((e as Error).message || e).slice(0, 120);
      continue;
    }
    if (res && res.status === true && res.result && dlUrls(res.result).length > 0) {
      return res.result;
    }
    lastMessage = String((res && res.message) || "tidak ada link unduhan");
  }
  throw new ScrapeError(
    lastMessage
      ? "Gagal mengambil medianya (" + lastMessage + "). Pastikan linknya publik dan coba lagi ya."
      : "Gagal mengambil medianya. Pastikan linknya publik dan coba lagi ya."
  );
}

/* ---------------- Normalisasi → DlCard ---------------- */

function mediaCard(
  platform: DlPlatform,
  result: ScraprResult,
  pick: { video?: ScraprDownload[]; audio?: ScraprDownload[]; images?: ScraprDownload[] }
): DlCard {
  const card: DlCard = {
    platform,
    type: "video",
    title: clip(result.title, 120),
    cover: httpsify(result.thumbnail),
    author: clip(result.artist, 60),
  };
  if (pick.video && pick.video.length > 0) {
    card.type = "video";
    card.video = httpsify(pick.video[0].url);
    return card;
  }
  if (pick.audio && pick.audio.length > 0) {
    card.type = "audio";
    card.music = httpsify(pick.audio[0].url);
    card.music_title = clip(pick.audio[0].quality || "MP3", 40);
    return card;
  }
  if (pick.images && pick.images.length > 0) {
    card.type = "image";
    card.images = pick.images.slice(0, 12).map((d) => httpsify(d.url)!).filter(Boolean);
    return card;
  }
  throw new ScrapeError("Medianya tidak ditemukan. Pastikan linknya publik dan coba lagi ya.");
}

function normalize(platform: DlPlatform, r: ScraprResult): DlCard {
  const ds = dlUrls(r);

  switch (platform) {
    case "twitter":
    case "threads": {
      const vids = ds.filter((d) => d.type === "video");
      const imgs = ds.filter((d) => d.type === "image");
      return mediaCard(platform, r, { video: vids, images: imgs });
    }
    case "facebook": {
      const vids = ds.filter((d) => String(d.type || "").toLowerCase().includes("video"));
      // snapsave: SD/HD — pilih label HD bila ada
      vids.sort((a, b) => (/hd/i.test(b.quality || "") ? 1 : 0) - (/hd/i.test(a.quality || "") ? 1 : 0));
      const auds = ds.filter((d) => String(d.type || "").toLowerCase().includes("audio"));
      const card = mediaCard(platform, r, { video: vids });
      if (card.type === "video" && auds.length > 0) card.music = httpsify(auds[0].url);
      return card;
    }
    case "spotify":
    case "bandcamp": {
      if (r.type === "playlist" || r.type === "album") {
        throw new ScrapeError(
          "Linknya album/playlist ya — kirim link satu lagunya aja biar bisa diunduh."
        );
      }
      const auds = ds.filter((d) => /mp3|audio/i.test(String(d.type || "")) || /kbps|kb\b/i.test(String(d.quality || "")));
      return mediaCard(platform, r, { audio: auds });
    }
    case "soundcloud": {
      const auds = ds.filter((d) => /mp3|audio/i.test(String(d.type || "")) || /kbps/i.test(String(d.type || "")));
      return mediaCard(platform, r, { audio: auds });
    }
    case "pinterest":
    case "pixiv": {
      const imgs = ds.filter((d) => String(d.type || "").toLowerCase().includes("image"));
      const card = mediaCard(platform, r, { images: imgs });
      // Pixiv: judul bentuk "Artwork by Artist" → pisah biar rapi
      if (platform === "pixiv" && card.title && !card.author) {
        const m = card.title.match(/^(.*?) by (.+)$/);
        if (m) {
          card.title = m[1];
          card.author = clip(m[2], 60);
        }
      }
      if (!card.cover && card.images && card.images.length > 0) card.cover = card.images[0];
      return card;
    }
    case "bilibili": {
      const vids = ds.filter((d) => String(d.type || "").toLowerCase().includes("video"));
      return mediaCard(platform, r, { video: vids });
    }
    case "rednote": {
      const vids = ds.filter((d) => String(d.type || "").toLowerCase().includes("video"));
      const imgs = ds.filter((d) => String(d.type || "").toLowerCase().includes("image"));
      return mediaCard(platform, r, { video: vids, images: imgs });
    }
    case "reddit": {
      const vids = ds.filter((d) => String(d.type || "").toLowerCase().includes("video"));
      const auds = ds.filter((d) => String(d.type || "").toLowerCase().includes("audio"));
      const card = mediaCard(platform, r, { video: vids });
      if (card.type === "video" && auds.length > 0) card.music = httpsify(auds[0].url);
      return card;
    }
    case "terabox": {
      const file = ds.find((d) => d.type === "file");
      if (!file) {
        throw new ScrapeError("File di share link TeraBox-nya tidak bisa diunduh langsung.");
      }
      return {
        platform,
        type: "file",
        title: clip(file.filename || r.title, 120) || "File TeraBox",
        video: httpsify(file.url),
      };
    }
    case "mediafire":
    case "sfile":
    case "sub2unlock": {
      const url = httpsify(r.url);
      if (!url) throw new ScrapeError("Gagal me-resolve linknya. Coba lagi ya.");
      return {
        platform,
        type: "file",
        title: clip(r.filename || r.title, 120) || "File unduhan",
        video: url,
      };
    }
    default:
      throw new ScrapeError("Platform tidak didukung.");
  }
}

/** Entry point dari chat route. */
export async function scrapeExtraDl(platform: DlPlatform, url: string): Promise<DlCard> {
  if (platform === "mediafire" || platform === "sfile" || platform === "sub2unlock") {
    const fn = scrapr.resolver[platform];
    let res: { status: boolean; result?: ScraprResult; message?: string };
    try {
      res = await fn(url);
    } catch (e) {
      throw new ScrapeError("Gagal me-resolve linknya (" + String((e as Error).message || e).slice(0, 80) + "). Coba lagi ya.");
    }
    if (!res || res.status !== true || !res.result || !res.result.url) {
      throw new ScrapeError("Linknya tidak bisa di-resolve. Pastikan masih aktif dan coba lagi ya.");
    }
    return normalize(platform, res.result);
  }

  const r = await runChain(platform, platform, url);
  return normalize(platform, r);
}
