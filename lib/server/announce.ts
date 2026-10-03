/* ============================================================
   Aomi — lib/server/announce.ts
   Pengumuman website (banner). Dibaca app/page.tsx (server) dan
   diatur lewat bot Telegram admin.
   ============================================================ */

import { readJson, putJson } from "./store";
import { KEYS } from "@/lib/redis/keys";

export interface AnnouncementState {
  enabled: boolean;
  title: string;
  message: string;
  updated_at: string;
  updated_by: number | null;
}

export const DEFAULT_ANNOUNCEMENT: AnnouncementState = {
  enabled: false,
  title: "Pengumuman",
  message: "",
  updated_at: "",
  updated_by: null,
};

let annCache: { state: AnnouncementState; at: number } | null = null;
const ANN_CACHE_MS = 30_000;

export async function getAnnouncement(): Promise<AnnouncementState> {
  if (annCache && Date.now() - annCache.at < ANN_CACHE_MS) return annCache.state;
  const file = await readJson<AnnouncementState>(KEYS.announcement).catch(() => null);
  const r = (file?.data || {}) as Partial<AnnouncementState>;
  const state: AnnouncementState = {
    enabled: r.enabled === true,
    title: typeof r.title === "string" && r.title.trim() ? r.title.trim() : DEFAULT_ANNOUNCEMENT.title,
    message: typeof r.message === "string" ? r.message.trim().slice(0, 300) : "",
    updated_at: typeof r.updated_at === "string" ? r.updated_at : "",
    updated_by: typeof r.updated_by === "number" ? r.updated_by : null,
  };
  annCache = { state, at: Date.now() };
  return state;
}

export async function setAnnouncement(state: AnnouncementState): Promise<void> {
  await putJson(KEYS.announcement, state, "announcement");
  annCache = { state, at: Date.now() };
}
