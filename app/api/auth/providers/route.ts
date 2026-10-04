// ============================================================
// POST /api/auth/providers — kelola provider yang terhubung.
// Body: { provider: "google"|"discord"|"facebook"|"telegram",
//         action: "disconnect" }
// Aturan: user tidak boleh melepas SATU-SATUNYA metode login —
// harus punya password atau minimal satu provider lain.
// ============================================================

import { json, methodNotAllowed, readBody } from "@/lib/server/http";
import { getSession } from "@/lib/server/auth";
import { readJson, updateJson } from "@/lib/server/store";
import type { UserIndex, UserRecord, ProviderId } from "@/lib/server/oauth";

export const dynamic = "force-dynamic";

const VALID: ProviderId[] = ["google", "discord", "facebook", "telegram"];

const FIELD: Record<ProviderId, "google_id" | "discord_id" | "facebook_id" | "telegram_id"> = {
  google: "google_id",
  discord: "discord_id",
  facebook: "facebook_id",
  telegram: "telegram_id",
};
const IDX: Record<ProviderId, keyof UserIndex> = {
  google: "google_ids",
  discord: "discord_ids",
  facebook: "facebook_ids",
  telegram: "telegram_ids",
};

export async function POST(req: Request) {
  const session = await getSession(req.headers);
  if (!session) {
    return json({ error: "Sesi berakhir. Silakan login kembali.", code: "SESSION_INVALID" }, 401);
  }

  const b = await readBody(req);
  const provider = String(b?.provider || "") as ProviderId;
  if (b?.action !== "disconnect" || !VALID.includes(provider)) {
    return json({ error: "Permintaan tidak valid." }, 400);
  }

  const userFile = await readJson<UserRecord>(`users/${session.user_id}.json`);
  if (!userFile) return json({ error: "User tidak ditemukan", code: "SESSION_INVALID" }, 401);
  const user = userFile.data;

  const providerIdValue = user[FIELD[provider]];
  if (!providerIdValue) {
    return json({ error: "Provider ini belum terhubung." }, 400);
  }

  // Metode login tersisa setelah disconnect
  const others: ProviderId[] = VALID.filter((p) => p !== provider && user[FIELD[p]]);
  if (!user.password_hash && others.length === 0) {
    return json(
      { error: "Kamu butuh minimal satu cara masuk. Tambahkan provider lain atau setel password dulu." },
      400
    );
  }

  await updateJson<UserRecord>(`users/${session.user_id}.json`, "provider disconnect", (current) => {
    if (!current) return undefined;
    const next = { ...current };
    delete next[FIELD[provider]];
    return next;
  });

  await updateJson<UserIndex>("users/_index.json", "provider disconnect index", (current) => {
    const data = current || {};
    const map = data[IDX[provider]];
    if (map) delete map[String(providerIdValue)];
    return data;
  });

  return json({ ok: true });
}

export async function GET() {
  return methodNotAllowed("POST");
}
