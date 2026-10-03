/* ============================================================
   Aomi — lib/server/maintenance-pure.ts
   Fungsi evaluasi maintenance MURNI (tanpa import/network) supaya
   bisa dites langsung oleh Node dan dipakai di middleware edge.
   Sumber kebenaran bentuk data: file ini.
   ============================================================ */

export interface MaintenanceState {
  mode: "off" | "on" | "scheduled";
  scheduled_start: string | null; // ISO 8601
  scheduled_end: string | null; // ISO 8601
  updated_at: string;
  updated_by: number | null; // Telegram user id admin terakhir
}

export interface MaintenanceConfig {
  title: string;
  message: string;
  eta: string; // teks bebas, "" jika kosong
  updated_at: string;
  updated_by: number | null;
}

export const DEFAULT_MAINTENANCE_STATE: MaintenanceState = {
  mode: "off",
  scheduled_start: null,
  scheduled_end: null,
  updated_at: "",
  updated_by: null,
};

export const DEFAULT_MAINTENANCE_CONFIG: MaintenanceConfig = {
  title: "Aomi sedang dirapikan",
  message: "Kami sedang melakukan beberapa perbaikan di balik layar. Coba lagi sebentar ya.",
  eta: "",
  updated_at: "",
  updated_by: null,
};

/** Normalisasi state yang dibaca dari storage (tahan data lama/rusak). */
export function normalizeState(raw: unknown): MaintenanceState {
  const r = (raw || {}) as Partial<MaintenanceState>;
  const mode =
    r.mode === "on" || r.mode === "scheduled" || r.mode === "off" ? r.mode : "off";
  const start = typeof r.scheduled_start === "string" ? r.scheduled_start : null;
  const end = typeof r.scheduled_end === "string" ? r.scheduled_end : null;
  return {
    mode,
    scheduled_start: mode === "scheduled" ? start : start, // simpan apa adanya
    scheduled_end: end,
    updated_at: typeof r.updated_at === "string" ? r.updated_at : "",
    updated_by: typeof r.updated_by === "number" ? r.updated_by : null,
  };
}

/** Evaluasi: apakah maintenance sedang berlaku pada waktu `nowMs`. */
export function evaluateActive(state: MaintenanceState, nowMs: number): boolean {
  if (state.mode === "on") return true;
  if (state.mode !== "scheduled") return false;
  const start = state.scheduled_start ? Date.parse(state.scheduled_start) : NaN;
  const end = state.scheduled_end ? Date.parse(state.scheduled_end) : NaN;
  if (!Number.isFinite(start)) return false;
  if (Number.isFinite(end) && nowMs > end) return false;
  return nowMs >= start;
}

/** Parse input jadwal admin: "YYYY-MM-DD HH:mm-HH:mm" (WIB, UTC+7). */
export function parseScheduleInput(text: string): { start: string; end: string } | null {
  const m = String(text || "").trim().match(
    /^(\d{4})-(\d{2})-(\d{2})[ ]+(\d{1,2}):(\d{2})[ ]*[-–][ ]*(\d{1,2}):(\d{2})$/
  );
  if (!m) return null;
  const [, y, mo, d, h1, mi1, h2, mi2] = m;
  const mk = (h: string, mi: string) =>
    Date.parse(`${y}-${mo}-${d}T${String(h).padStart(2, "0")}:${mi}:00.000+07:00`);
  const start = mk(h1, mi1);
  const end = mk(h2, mi2);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
  };
}
