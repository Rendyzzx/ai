/* ============================================================
   Aomi — lib/server/hdvid.ts
   Fitur HD video (upgrade kualitas video via API faa):
   1. submit job  → POST/GET /faa/hdvid?url=<video>  → { job_id }
   2. poll hasil  → GET  /faa/result?id=<job_id>      → { state,
      download_url } — dipanggil berulang sampai state "done".
   Pola dua-langkah ini dipakai client (poll tiap beberapa detik)
   supaya request chat tidak menggantung menunggu proses ±40 detik.
   ============================================================ */

const HD_API = "https://api-faa.my.id/faa/hdvid";
const HD_RESULT_API = "https://api-faa.my.id/faa/result";

/** Hanya host hasil faa yang boleh di-proxy unduhannya (anti SSRF). */
export const HD_RESULT_HOSTS = [
  /^([a-z0-9-]+\.)?uguu\.se$/i,
  /^([a-z0-9-]+\.)?api-faa\.my\.id$/i,
];

export class HdError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Job ID valid dari API faa (format: faa_xxxxxxxx). */
export const HD_JOB_RE = /^[a-z0-9_-]{6,64}$/i;

async function fetchJson(url: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { signal: ctrl.signal });
  } catch {
    throw new HdError("NETWORK", "Layanan HD tidak bisa dihubungi");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new HdError("HTTP_" + res.status, "Layanan HD balas " + res.status);
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    throw new HdError("BADJSON", "Respons layanan HD tidak valid");
  }
}

/** Kirim job HD untuk satu URL video → { job_id }. */
export async function submitHdJob(videoUrl: string): Promise<{ job_id: string }> {
  const out = await fetchJson(HD_API + "?url=" + encodeURIComponent(videoUrl), 20_000);
  if (out.status !== true || typeof out.job_id !== "string" || !out.job_id) {
    throw new HdError("REJECTED", "Video ditolak layanan HD");
  }
  return { job_id: out.job_id };
}

export interface HdPollResult {
  state: "pending" | "done" | "error";
  download_url: string | null;
  quality: string | null;
}

/**
 * Cek status satu job. "done" → download_url tersedia.
 * State tidak dikenal (dan API balas status:false berulang) → error.
 */
export async function pollHdJob(jobId: string): Promise<HdPollResult> {
  const out = await fetchJson(HD_RESULT_API + "?id=" + encodeURIComponent(jobId), 15_000);
  const state = String(out.state || "");
  if (state === "done" && out.result && typeof out.result === "object") {
    const r = out.result as Record<string, unknown>;
    const dl = typeof r.download_url === "string" ? r.download_url : "";
    if (!dl) throw new HdError("NOURL", "Hasil HD tanpa URL unduhan");
    return {
      state: "done",
      download_url: dl,
      quality: typeof r.quality === "string" ? r.quality : null,
    };
  }
  if (state === "processing" || state === "pending" || state === "queued") {
    return { state: "pending", download_url: null, quality: null };
  }
  // status:false / state gagal / format tak dikenal
  return { state: "error", download_url: null, quality: null };
}
