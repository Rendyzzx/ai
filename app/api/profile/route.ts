// ============================================================
// /api/profile — profil user (wajib login; user_id SELALU dari
// session, tidak pernah dari request body).
// GET → profil; PUT → { username?, display_name?, bio?, avatar? }
// Port dari api/profile.js — behavior & validasi identik.
// ============================================================

import { readJson, putJson, updateJson } from "@/lib/server/store";
import { maintenanceBlockResponse } from "@/lib/server/maintenance";
import { getSession } from "@/lib/server/auth";
import { allowUser } from "@/lib/server/ratelimit";
import { json, methodNotAllowed, readBody, forbidden, originOk } from "@/lib/server/http";
import type { UserProfile } from "@/types";

export const dynamic = "force-dynamic";

const AVATAR_MAX_BYTES = 200 * 1024;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

interface StoredUser {
  id: string;
  username: string;
  email: string;
  display_name?: string;
  bio?: string;
  avatar?: string | null;
  password_hash: string;
}

function sanitize(str: unknown, maxLen: number): string {
  return String(str ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .slice(0, maxLen)
    .trim();
}

/** Validasi avatar data URL. Return null = valid/kosong; string = error. */
function validateAvatar(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null; // hapus foto
  if (typeof value !== "string") return "Foto profil tidak valid.";

  const m = (value as string).match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return "Foto profil harus berupa JPG, PNG, atau WebP.";
  if (value.length > AVATAR_MAX_BYTES * 1.4) return "Foto terlalu besar.";

  let buf: Buffer;
  try {
    buf = Buffer.from(m[2], "base64");
  } catch {
    return "Foto profil tidak valid.";
  }
  if (buf.length === 0 || buf.length > AVATAR_MAX_BYTES) {
    return "Foto terlalu besar (maks 200 KB).";
  }

  // Magic bytes: pastikan benar-benar file gambar
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

  const userFile = await readJson<StoredUser>(`users/${uid}.json`);
  if (!userFile) return json({ error: "User tidak ditemukan", code: "SESSION_INVALID" }, 401);
  const user = userFile.data;

  return json({
    username: user.username,
    display_name: user.display_name || user.username,
    bio: user.bio || "",
    avatar: user.avatar || null,
  });
}

export async function PUT(req: Request) {
  const session = await getSession(req.headers);
  if (!session) return json({ error: "Sesi berakhir. Silakan login kembali.", code: "SESSION_INVALID" }, 401);

  if (session) {
    const maintGate = await maintenanceBlockResponse();
    if (maintGate) return maintGate;
  }
  const uid = session.user_id;

  const userFile = await readJson<StoredUser>(`users/${uid}.json`);
  if (!userFile) return json({ error: "User tidak ditemukan", code: "SESSION_INVALID" }, 401);
  const user = userFile.data;

  if (!allowUser("profile", uid, req, 20, 60 * 1000)) {
    return json({ error: "Terlalu banyak perubahan. Tunggu sebentar." }, 429);
  }

  const body = await readBody(req);
  const next: StoredUser = { ...user };

  if (Object.prototype.hasOwnProperty.call(body, "username")) {
    const username = sanitize(body.username, 20);
    if (!USERNAME_RE.test(username)) {
      return json({ error: "Username 3-20 karakter, hanya huruf, angka, dan underscore." }, 400);
    }
    const index = await readJson<{ usernames?: Record<string, string> }>("users/_index.json");
    const idx = index?.data || { usernames: {} };
    const owner = idx.usernames?.[username.toLowerCase()];
    if (owner && owner !== uid) {
      return json({ error: "Username sudah dipakai." }, 409);
    }
    // perbarui indeks (hapus key lama, tambah yang baru)
    await updateJson<{ emails?: Record<string, string>; usernames?: Record<string, string> }>(
      "users/_index.json",
      "username index",
      (current) => {
        const data = current || { emails: {}, usernames: {} };
      data.usernames = data.usernames || {};
      if (user.username) delete data.usernames[String(user.username).toLowerCase()];
      data.usernames[username.toLowerCase()] = uid;
      return data;
    });
    next.username = username;
    if (!next.display_name) next.display_name = username;
  }

  if (Object.prototype.hasOwnProperty.call(body, "display_name")) {
    const dn = sanitize(body.display_name, 40);
    if (!dn) return json({ error: "Nama tampilan wajib diisi." }, 400);
    next.display_name = dn;
  }

  if (Object.prototype.hasOwnProperty.call(body, "bio")) {
    next.bio = sanitize(body.bio, 200);
  }

  if (Object.prototype.hasOwnProperty.call(body, "avatar")) {
    const err = validateAvatar(body.avatar);
    if (err) return json({ error: err }, 400);
    next.avatar = (body.avatar as string) || null;
  }

  await putJson(`users/${uid}.json`, next, "profile update");

  return json({
    username: next.username,
    display_name: next.display_name || next.username,
    bio: next.bio || "",
    avatar: next.avatar || null,
  });
}

export async function POST() {
  return methodNotAllowed("GET, PUT");
}
