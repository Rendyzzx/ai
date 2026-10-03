/* ============================================================
   Aomi — lib/server/maintenance.ts
   Service maintenance: state + konfigurasi halaman. Semua akses
   bot Telegram DAN website lewat file ini (satu sumber kebenaran).
   ============================================================ */

import { readJson, putJson } from "./store";
import { json } from "./http";
import { KEYS } from "@/lib/redis/keys";
import {
  DEFAULT_MAINTENANCE_CONFIG,
  DEFAULT_MAINTENANCE_STATE,
  evaluateActive,
  normalizeState,
  type MaintenanceConfig,
  type MaintenanceState,
} from "./maintenance-pure";

/** Cache pendek supaya gate per-request tetap murah di mode fallback GitHub. */
let activeCache: { active: boolean; at: number } | null = null;
const ACTIVE_CACHE_MS = 15_000;

export async function getMaintenanceState(): Promise<MaintenanceState> {
  const file = await readJson<MaintenanceState>(KEYS.maintenanceState).catch(() => null);
  return normalizeState(file?.data ?? DEFAULT_MAINTENANCE_STATE);
}

export async function setMaintenanceState(state: MaintenanceState): Promise<void> {
  await putJson(KEYS.maintenanceState, state, "maintenance state");
  activeCache = { active: evaluateActive(state, Date.now()), at: Date.now() };
}

export async function getMaintenanceConfig(): Promise<MaintenanceConfig> {
  const file = await readJson<MaintenanceConfig>(KEYS.maintenanceConfig).catch(() => null);
  const r = (file?.data || {}) as Partial<MaintenanceConfig>;
  return {
    title: typeof r.title === "string" && r.title.trim() ? r.title.trim() : DEFAULT_MAINTENANCE_CONFIG.title,
    message:
      typeof r.message === "string" && r.message.trim()
        ? r.message.trim()
        : DEFAULT_MAINTENANCE_CONFIG.message,
    eta: typeof r.eta === "string" ? r.eta.trim() : "",
    updated_at: typeof r.updated_at === "string" ? r.updated_at : "",
    updated_by: typeof r.updated_by === "number" ? r.updated_by : null,
  };
}

export async function setMaintenanceConfig(cfg: MaintenanceConfig): Promise<void> {
  await putJson(KEYS.maintenanceConfig, cfg, "maintenance config");
}

/** Apakah maintenance sedang berlaku (cache 15 detik per instance). */
export async function isMaintenanceActive(): Promise<boolean> {
  if (activeCache && Date.now() - activeCache.at < ACTIVE_CACHE_MS) {
    return activeCache.active;
  }
  const state = await getMaintenanceState();
  const active = evaluateActive(state, Date.now());
  activeCache = { active, at: Date.now() };
  return active;
}

/** Invalidasi cache (dipanggil setelah setMaintenanceState di instance yang sama). */
export function resetMaintenanceCache(): void {
  activeCache = null;
}


/**
 * Gerbang maintenance untuk route privat: kembalikan Response 503 jika
 * sedang maintenance, null jika request boleh lanjut.
 * Route Telegram webhook TIDAK memakai gerbang ini (admin harus tetap
 * bisa mematikan maintenance).
 */
export async function maintenanceBlockResponse(): Promise<Response | null> {
  try {
    if (await isMaintenanceActive()) {
      const cfg = await getMaintenanceConfig();
      const res = json(
        { error: `Situs sedang maintenance: ${cfg.message}`, code: "MAINTENANCE" },
        503
      );
      return res;
    }
    return null;
  } catch {
    // Storage error saat cek → jangan blokir situs (fail open untuk read
    // gate ini; aksi tulis admin tetap diverifikasi di service-nya).
    return null;
  }
}
