// ============================================================
// Aomi — lib/server/music.ts
// Resolusi lagu untuk mode musik (chat trigger "putarkan lagu").
// Port dari scrape eksternal:
//   - Pencarian lagu: YouTube search (scrape ytInitialData)
//   - Sumber audio:   savetube (decrypt metadata AES-128-CBC)
//   - Lirik:          LRCLIB (synced LRC, fallback plain lyrics)
// ============================================================

import { createDecipheriv } from "node:crypto";
import type { MusicCard, MusicLyricLine } from "@/types";
import { YT_URL_RE } from "@/lib/chat-utils";

const HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  Origin: "https://yt.savetube.me",
  "User-Agent":
    "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36",
};

const LRCLIB_API = "https://lrclib.net/api";
const LRCLIB_UA = "Aomi/1.0 (https://cyronime.web.id)";

/** Error dengan kode yang dikenal route (tanpa detail internal). */
export class MusicError extends Error {
  constructor(public code: "NO_CONFIG" | "NOT_FOUND" | "UPSTREAM", message: string) {
    super(message);
  }
}

/** fetch dengan timeout. */
async function fetchT(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- Util durasi ---------------- */

/** "4:08" / "1:02:03" → detik. */
export function secondsFromTimestamp(timestamp: string): number {
  if (!timestamp) return 0;
  const parts = String(timestamp).split(":").map(Number);
  if (parts.some(Number.isNaN)) return 0;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

/** "4.13 min" (label savetube) → detik. */
function secondsFromSavetubeLabel(label: string): number {
  const m = String(label || "").match(/^([\d.]+)\s*min$/i);
  if (m) return Math.round(Number(m[1]) * 60);
  return secondsFromTimestamp(label);
}

/** Bersih-bersih judul YouTube buat pencocokan lirik. */
function cleanTrackTitle(title: string): string {
  return String(title || "")
    .replace(/[([][^()]*?(?:official|video|audio|lyrics?|visualizer|remaster\w*|mv|m\/v|4k|hd|perfomance|performance)[^()]*?[)\]]/gi, "")
    .replace(/\s*[-–]\s*topic\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s\-–:]+|[\s\-–:]+$/g, "")
    .trim();
}

function cleanArtist(artist: string): string {
  return String(artist || "")
    .replace(/\s*[-–]\s*topic\s*$/i, "")
    .trim();
}

/* ---------------- YouTube search (scrape) ---------------- */

export interface TrackMeta {
  video_id: string;
  title: string;
  artist: string;
  duration: number; // detik
}

/** Cari lagu via YouTube search result page (filter: video only). */
export async function searchYouTube(query: string): Promise<TrackMeta> {
  const q = String(query || "").trim().slice(0, 200);
  if (!q) throw new MusicError("NOT_FOUND", "Kata kunci kosong");

  const res = await fetchT(
    "https://www.youtube.com/results?search_query=" +
      encodeURIComponent(q) +
      "&sp=EgIQAQ%253D%253D",
    {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0",
        "Accept-Language": "en-US,en;q=0.9",
      },
    },
    12_000
  );
  const html = await res.text();
  const m = html.match(/var ytInitialData\s*=\s*(\{.+?\});<\/script>/s);
  if (!m) throw new MusicError("UPSTREAM", "hasil pencarian tidak bisa dibaca");

  let data: unknown;
  try {
    data = JSON.parse(m[1]);
  } catch {
    throw new MusicError("UPSTREAM", "hasil pencarian rusak");
  }

  const found: { videoId: string; title: string; author: string; durationText: string }[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object" || found.length >= 12) return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    const vr = (node as { videoRenderer?: Record<string, unknown> }).videoRenderer;
    if (vr && typeof vr.videoId === "string" && /^[a-zA-Z0-9_-]{11}$/.test(vr.videoId)) {
      const title = (vr.title as { runs?: { text?: string }[] } | undefined)?.runs?.[0]?.text || "";
      const author =
        (vr.ownerText as { runs?: { text?: string }[] } | undefined)?.runs?.[0]?.text ||
        (vr.longBylineText as { runs?: { text?: string }[] } | undefined)?.runs?.[0]?.text ||
        "YouTube";
      const durationText = (vr.lengthText as { simpleText?: string } | undefined)
        ?.simpleText || "";
      if (title) found.push({ videoId: vr.videoId, title, author, durationText });
    }
    for (const v of Object.values(node)) walk(v);
  };
  walk(data);

  // Pilih hasil pertama yang bukan live dan durasinya wajar (≤ 1 jam)
  const ok = found.filter(
    (v) => v.durationText && !/live/i.test(v.durationText) && secondsFromTimestamp(v.durationText) <= 3600
  );
  const pick = ok[0] || found[0];
  if (!pick) throw new MusicError("NOT_FOUND", "Lagu tidak ditemukan di YouTube");

  return {
    video_id: pick.videoId,
    title: cleanTrackTitle(pick.title),
    artist: cleanArtist(pick.author),
    duration: secondsFromTimestamp(pick.durationText),
  };
}

/** Metadata video via oEmbed (untuk link YouTube langsung). */
export async function youTubeOEmbed(
  videoId: string
): Promise<{ title: string; artist: string } | null> {
  try {
    const res = await fetchT(
      "https://www.youtube.com/oembed?format=json&url=" +
        encodeURIComponent("https://www.youtube.com/watch?v=" + videoId),
      { headers: { "User-Agent": HEADERS["User-Agent"] } },
      8_000
    );
    if (!res.ok) return null;
    const d = (await res.json()) as { title?: string; author_name?: string };
    if (!d?.title) return null;
    return { title: cleanTrackTitle(d.title), artist: cleanArtist(d.author_name || "YouTube") };
  } catch {
    return null;
  }
}

/* ---------------- savetube (sumber audio) ---------------- */

// Key dekripsi metadata savetube (AES-128, hex 32 karakter) — key publik
// yang dipakai luas oleh scraper savetube. Env SAVETUBE_KEY tetap bisa
// dipakai untuk override tanpa redeploy.
const SAVETUBE_KEY_DEFAULT = "C5D58EF67A7584E4A29F6C35BBC4EB12";
const SAVETUBE_KEY_ENV = "SAVETUBE_KEY";

interface SavetubeResult {
  audio_url: string;
  title: string;
  duration: number; // detik
}

/** Satu percobaan resolve audio savetube. */
async function savetubeOnce(videoId: string): Promise<SavetubeResult> {
  const keyHex = process.env[SAVETUBE_KEY_ENV] || SAVETUBE_KEY_DEFAULT;
  if (!/^[0-9a-fA-F]{32}$/.test(keyHex)) {
    throw new MusicError("NO_CONFIG", "SAVETUBE_KEY tidak valid");
  }

  const cdnRes = await fetchT("https://media.savetube.vip/api/random-cdn", { headers: HEADERS }, 12_000)
    .then((v) => v.json())
    .catch(() => null);
  const cdn = (cdnRes as { cdn?: string } | null)?.cdn;
  if (!cdn) throw new MusicError("UPSTREAM", "CDN savetube tidak tersedia");

  const info = await fetchT(`https://${cdn}/v2/info`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${videoId}` }),
  }, 15_000)
    .then((v) => v.json())
    .catch(() => null);
  const infoData = (info as { data?: string } | null)?.data;
  if (!infoData) throw new MusicError("UPSTREAM", "metadata savetube kosong");

  // metadata terenkripsi AES-128-CBC (IV = 16 byte pertama)
  let metadata: { title?: string; durationLabel?: string; key?: string };
  try {
    const encrypted = Buffer.from(infoData, "base64");
    const decipher = createDecipheriv(
      "aes-128-cbc",
      Buffer.from(keyHex, "hex"),
      encrypted.subarray(0, 16)
    );
    const decrypted = Buffer.concat([decipher.update(encrypted.subarray(16)), decipher.final()]);
    metadata = JSON.parse(decrypted.toString("utf8"));
  } catch {
    throw new MusicError("UPSTREAM", "decrypt metadata gagal");
  }
  if (!metadata?.key) throw new MusicError("UPSTREAM", "key download tidak ditemukan");

  const dl = await fetchT(`https://${cdn}/download`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      id: videoId,
      downloadType: "audio",
      quality: "128kbps",
      key: metadata.key,
    }),
  }, 15_000)
    .then((v) => v.json())
    .catch(() => null);
  const downloadUrl = (dl as { data?: { downloadUrl?: string } } | null)?.data?.downloadUrl;
  if (!downloadUrl) throw new MusicError("UPSTREAM", "URL audio tidak tersedia");

  return {
    audio_url: downloadUrl,
    title: String(metadata.title || ""),
    duration: secondsFromSavetubeLabel(String(metadata.durationLabel || "")),
  };
}

/** Resolve audio savetube dengan retry. */
export async function savetubeAudio(videoId: string, retry = 3): Promise<SavetubeResult> {
  let lastErr: unknown = null;
  for (let i = 0; i < retry; i++) {
    try {
      return await savetubeOnce(videoId);
    } catch (err) {
      lastErr = err;
      // Konfigurasi hilang tidak akan sembahi dengan retry — langsung lempar
      if (err instanceof MusicError && err.code === "NO_CONFIG") throw err;
      if (i < retry - 1) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (lastErr instanceof MusicError) throw lastErr;
  throw new MusicError("UPSTREAM", "savetube gagal");
}

/* ---------------- LRCLIB (lirik) ---------------- */

interface LrcResult {
  lines: MusicLyricLine[];
  estimated: boolean; // plain lyrics disebar merata → sinkron perkiraan
}

/** Parse timestamp LRC: [mm:ss.xx] → detik. */
function parseLrcTimestamp(match: RegExpMatchArray): number | null {
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  const fractionText = match[3] || "";
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || seconds < 0 || seconds >= 60) {
    return null;
  }
  let milliseconds = 0;
  if (fractionText) {
    if (fractionText.length === 1) milliseconds = Number(fractionText) * 100;
    else if (fractionText.length === 2) milliseconds = Number(fractionText) * 10;
    else milliseconds = Number(fractionText.slice(0, 3));
  }
  return minutes * 60 + seconds + milliseconds / 1000;
}

/** LRC string → [{time, text}] terurut. */
function parseSyncedLyrics(lrc: string): MusicLyricLine[] {
  if (!lrc || typeof lrc !== "string") return [];
  const result: MusicLyricLine[] = [];
  const timestampRegex = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  for (const rawLine of lrc.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const matches = [...rawLine.matchAll(timestampRegex)];
    if (!matches.length) continue;
    const text = rawLine.replace(timestampRegex, "").trim();
    if (!text) continue;
    for (const match of matches) {
      const time = parseLrcTimestamp(match);
      if (time === null || !Number.isFinite(time) || time < 0) continue;
      result.push({ time, text });
    }
  }
  result.sort((a, b) => a.time - b.time);
  const cleaned: MusicLyricLine[] = [];
  for (const item of result) {
    const last = cleaned[cleaned.length - 1];
    if (last && Math.abs(last.time - item.time) < 0.001 && last.text === item.text) continue;
    cleaned.push(item);
  }
  return cleaned;
}

/** Plain lyrics → baris "sinkron" perkiraan (sebar merata per durasi). */
function plainLyricsToSynced(lyrics: string, duration: number): MusicLyricLine[] {
  const lines = String(lyrics || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return [];
  let interval = 5;
  if (Number.isFinite(duration) && duration > 0 && lines.length > 1) {
    interval = Math.max(2, Math.min(8, duration / lines.length));
  }
  return lines.map((text, index) => ({ time: index * interval, text }));
}

function normalizeLyrics(lines: MusicLyricLine[]): MusicLyricLine[] {
  return lines
    .filter((x) => x && Number.isFinite(Number(x.time)) && typeof x.text === "string")
    .map((x) => ({ time: Number(x.time), text: String(x.text).trim() }))
    .filter((x) => x.text)
    .sort((a, b) => a.time - b.time);
}

/** Ambil lirik sinkron dari LRCLIB. */
export async function getSyncedLyrics(
  title: string,
  artist: string,
  duration: number
): Promise<LrcResult> {
  try {
    if (!title || !artist) return { lines: [], estimated: false };
    const params = new URLSearchParams({
      track_name: String(title).trim(),
      artist_name: String(artist).trim(),
    });
    const dur = Number(duration);
    if (Number.isFinite(dur) && dur >= 1 && dur <= 3600) {
      params.set("duration", String(Math.round(dur)));
    }
    let res = await fetchT(`${LRCLIB_API}/get?${params.toString()}`, {
      headers: { Accept: "application/json", "User-Agent": LRCLIB_UA },
    }, 8_000);
    // Durasi dari label savetube bisa meleset → coba sekali lagi tanpa durasi
    if (!res.ok && params.has("duration")) {
      params.delete("duration");
      res = await fetchT(`${LRCLIB_API}/get?${params.toString()}`, {
        headers: { Accept: "application/json", "User-Agent": LRCLIB_UA },
      }, 8_000);
    }
    if (!res.ok) return { lines: [], estimated: false };
    const data = (await res.json()) as {
      plainLyrics?: unknown;
      syncedLyrics?: unknown;
    } | null;
    if (!data) return { lines: [], estimated: false };

    const synced = typeof data.syncedLyrics === "string" ? parseSyncedLyrics(data.syncedLyrics) : [];
    if (synced.length) return { lines: normalizeLyrics(synced), estimated: false };

    const plain = typeof data.plainLyrics === "string" ? data.plainLyrics : "";
    if (plain) return { lines: normalizeLyrics(plainLyricsToSynced(plain, duration)), estimated: true };

    return { lines: [], estimated: false };
  } catch {
    return { lines: [], estimated: false };
  }
}

/* ---------------- Resolusi lengkap → MusicCard ---------------- */

/**
 * Query bisa berupa kata kunci pencarian ATAU link YouTube.
 * Menghasilkan kartu lagu siap simpan + diputar.
 */
export async function resolveMusicCard(query: string): Promise<MusicCard> {
  const ytMatch = String(query || "").match(YT_URL_RE);
  let meta: TrackMeta;
  let audio: SavetubeResult;

  if (ytMatch) {
    const videoId = ytMatch[1];
    // oEmbed (judul + artis) jalan paralel dengan savetube (audio + durasi)
    const [oe, st] = await Promise.all([youTubeOEmbed(videoId), savetubeAudio(videoId)]);
    audio = st;
    meta = {
      video_id: videoId,
      title: oe?.title || cleanTrackTitle(audio.title) || "Lagu",
      artist: oe?.artist || "YouTube",
      duration: audio.duration,
    };
  } else {
    const found = await searchYouTube(query);
    // savetube + lirik jalan paralel
    const [st, lrc] = await Promise.all([
      savetubeAudio(found.video_id),
      getSyncedLyrics(found.title, found.artist, found.duration),
    ]);
    return {
      video_id: found.video_id,
      title: found.title.slice(0, 120),
      artist: found.artist.slice(0, 80),
      duration: found.duration || st.duration,
      thumbnail: `https://i.ytimg.com/vi/${found.video_id}/hqdefault.jpg`,
      audio_url: st.audio_url,
      lyrics: lrc.lines.slice(0, 200),
      lyrics_estimated: lrc.estimated,
    };
  }

  const lrc = await getSyncedLyrics(meta.title, meta.artist, meta.duration);
  return {
    video_id: meta.video_id,
    title: meta.title.slice(0, 120),
    artist: meta.artist.slice(0, 80),
    duration: meta.duration,
    thumbnail: `https://i.ytimg.com/vi/${meta.video_id}/hqdefault.jpg`,
    audio_url: audio.audio_url,
    lyrics: lrc.lines.slice(0, 200),
    lyrics_estimated: lrc.estimated,
  };
}
