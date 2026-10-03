// ============================================================
// /api/bot — karakter companion per user (isolasi per akun).
// GET → konfigurasi (merge default); PUT → field yang berubah saja.
// Port dari api/bot.js — behavior & validasi identik.
// ============================================================

import { readJson, putJson } from "@/lib/server/store";
import { maintenanceBlockResponse } from "@/lib/server/maintenance";
import { getSession } from "@/lib/server/auth";
import { allowUser } from "@/lib/server/ratelimit";
import { json, methodNotAllowed, readBody, forbidden, originOk } from "@/lib/server/http";
import { DEFAULT_BOT, TRAITS, SPEAKING_STYLES, RELATIONSHIPS } from "@/lib/server/bot-config";
import type { BotConfig } from "@/types";

export const dynamic = "force-dynamic";

const AVATAR_MAX_BYTES = 200 * 1024;
const LANGUAGES = ["auto", "id", "en"];
const LENGTHS = ["concise", "balanced", "detailed"];
const STYLES = ["casual", "neutral", "formal"];
const PRESETS = ["friendly", "professional", "creative", "custom"];

function sanitize(str: unknown, maxLen: number): string {
  return String(str ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .slice(0, maxLen)
    .trim();
}

function validateAvatar(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return "Avatar bot tidak valid.";
  const m = value.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return "Avatar harus berupa JPG, PNG, atau WebP.";
  if (value.length > AVATAR_MAX_BYTES * 1.4) return "Avatar terlalu besar.";
  let buf: Buffer;
  try {
    buf = Buffer.from(m[2], "base64");
  } catch {
    return "Avatar tidak valid.";
  }
  if (buf.length === 0 || buf.length > AVATAR_MAX_BYTES) return "Avatar terlalu besar (maks 200 KB).";
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const isWebp =
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP";
  if (!isJpg && !isPng && !isWebp) return "File bukan gambar yang valid.";
  return null;
}

export async function GET(req: Request) {
  const session = await getSession(req.headers);
  if (!session) return json({ error: "Sesi berakhir. Silakan login kembali.", code: "SESSION_INVALID" }, 401);

  if (session) {
    const maintGate = await maintenanceBlockResponse();
    if (maintGate) return maintGate;
  }
  const uid = session.user_id;

  if (!originOk(req)) return forbidden();

  const botPath = `bots/${uid}.json`;
  const existing = await readJson<BotConfig>(botPath);
  const current: BotConfig = { ...DEFAULT_BOT, ...(existing?.data || {}) };
  return json({ bot: current });
}

export async function PUT(req: Request) {
  const session = await getSession(req.headers);
  if (!session) return json({ error: "Sesi berakhir. Silakan login kembali.", code: "SESSION_INVALID" }, 401);

  if (session) {
    const maintGate = await maintenanceBlockResponse();
    if (maintGate) return maintGate;
  }
  const uid = session.user_id;

  const botPath = `bots/${uid}.json`;
  const existing = await readJson<BotConfig>(botPath);
  const current: BotConfig = { ...DEFAULT_BOT, ...(existing?.data || {}) };

  if (!allowUser("bot", uid, req, 20, 60 * 1000)) {
    return json({ error: "Terlalu banyak perubahan. Tunggu sebentar." }, 429);
  }

  const body = await readBody(req);
  const next: BotConfig = { ...current };

  if (Object.prototype.hasOwnProperty.call(body, "bot_name")) {
    const name = sanitize(body.bot_name, 40);
    if (!name) return json({ error: "Nama bot wajib diisi." }, 400);
    next.bot_name = name;
  }

  if (Object.prototype.hasOwnProperty.call(body, "bot_description")) {
    next.bot_description = sanitize(body.bot_description, 120);
  }

  if (Object.prototype.hasOwnProperty.call(body, "bot_avatar")) {
    const err = validateAvatar(body.bot_avatar);
    if (err) return json({ error: err }, 400);
    next.bot_avatar = (body.bot_avatar as string) || null;
  }

  if (Object.prototype.hasOwnProperty.call(body, "personality_preset")) {
    if (!PRESETS.includes(body.personality_preset as string)) {
      return json({ error: "Preset personality tidak valid." }, 400);
    }
    next.personality_preset = body.personality_preset as string;
  }

  if (Object.prototype.hasOwnProperty.call(body, "personality")) {
    next.personality = sanitize(body.personality, 3000);
  }

  if (Object.prototype.hasOwnProperty.call(body, "traits")) {
    const list = Array.isArray(body.traits) ? body.traits : [];
    next.traits = (list.filter((t) => TRAITS.includes(t as string)) as string[]).slice(0, 5);
  }

  if (Object.prototype.hasOwnProperty.call(body, "speaking_style")) {
    if (!SPEAKING_STYLES.includes(body.speaking_style as string)) {
      return json({ error: "Gaya bicara tidak valid." }, 400);
    }
    next.speaking_style = body.speaking_style as string;
  }

  if (Object.prototype.hasOwnProperty.call(body, "relationship")) {
    if (!RELATIONSHIPS.includes(body.relationship as string)) {
      return json({ error: "Hubungan tidak valid." }, 400);
    }
    next.relationship = body.relationship as string;
  }

  if (Object.prototype.hasOwnProperty.call(body, "greeting")) {
    next.greeting = sanitize(body.greeting, 200);
  }

  if (Object.prototype.hasOwnProperty.call(body, "likes")) {
    next.likes = sanitize(body.likes, 300);
  }

  if (Object.prototype.hasOwnProperty.call(body, "avoids")) {
    next.avoids = sanitize(body.avoids, 300);
  }

  if (Object.prototype.hasOwnProperty.call(body, "memories")) {
    const list = Array.isArray(body.memories) ? body.memories : [];
    next.memories = list
      .map((m) => sanitize(String(m), 200))
      .filter(Boolean)
      .slice(0, 12);
  }

  if (Object.prototype.hasOwnProperty.call(body, "system_prompt")) {
    next.system_prompt = sanitize(body.system_prompt, 1000);
  }

  if (Object.prototype.hasOwnProperty.call(body, "language")) {
    if (!LANGUAGES.includes(body.language as string)) {
      return json({ error: "Bahasa tidak valid." }, 400);
    }
    next.language = body.language as BotConfig["language"];
  }

  if (Object.prototype.hasOwnProperty.call(body, "response_length")) {
    if (!LENGTHS.includes(body.response_length as string)) {
      return json({ error: "Panjang jawaban tidak valid." }, 400);
    }
    next.response_length = body.response_length as BotConfig["response_length"];
  }

  if (Object.prototype.hasOwnProperty.call(body, "response_style")) {
    if (!STYLES.includes(body.response_style as string)) {
      return json({ error: "Nada bicara tidak valid." }, 400);
    }
    next.response_style = body.response_style as BotConfig["response_style"];
  }

  await putJson(botPath, next, "bot settings update");
  return json({ bot: next });
}

export async function POST() {
  return methodNotAllowed("GET, PUT");
}
