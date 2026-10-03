// ============================================================
// /api/conversations — riwayat percakapan per user (wajib login)
// GET → daftar | GET ?id= → isi satu | POST → buat baru / action=recover
// DELETE ?id= → hapus percakapan | DELETE ?id&message_id= → hapus 1 pesan
// Port dari api/conversations.js — behavior identik.
// ============================================================

import crypto from "node:crypto";
import { readJson, putJson, updateJson, deleteJson, listJsonPaths } from "@/lib/server/store";
import { maintenanceBlockResponse } from "@/lib/server/maintenance";
import { getSession } from "@/lib/server/auth";
import { allowUser } from "@/lib/server/ratelimit";
import { json, methodNotAllowed, readBody, tooMany, forbidden, originOk } from "@/lib/server/http";
import type { Conversation, ConversationItem, Message } from "@/types";

export const dynamic = "force-dynamic";

const convPath = (uid: string, id: string) => `chats/${uid}/${id}.json`;
const idxPath = (uid: string) => `chats/${uid}/_index.json`;

const nowIso = () => new Date().toISOString();

async function readIndex(uid: string): Promise<ConversationItem[]> {
  const file = await readJson<ConversationItem[]>(idxPath(uid));
  const items = Array.isArray(file?.data) ? file.data : [];
  return items.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
}

/** Upsert entri index percakapan (dipakai semua jalur tulis pesan). */
async function touchIndex(uid: string, entry: ConversationItem): Promise<void> {
  await updateJson<ConversationItem[]>(idxPath(uid), "conversation index", (current) => {
    const items = Array.isArray(current) ? current : [];
    const i = items.findIndex((c) => c.conversation_id === entry.conversation_id);
    if (i >= 0) items[i] = entry;
    else items.unshift(entry);
    return items;
  });
}

export async function GET(req: Request) {
  const session = await getSession(req.headers);
  if (!session) return json({ error: "Belum login", code: "SESSION_INVALID" }, 401);

  if (session) {
    const maintGate = await maintenanceBlockResponse();
    if (maintGate) return maintGate;
  }
  const uid = session.user_id;

  const { searchParams } = new URL(req.url);

  // ?export=1 → unduhan lengkap (Settings > Data). Login wajib (dicek di atas).
  // Ini satu-satunya jalur "mass read" → limit sangat ketat per user.
  if (searchParams.get("export") === "1") {
    if (!allowUser("convs-export", uid, req, 3, 60 * 60_000)) {
      return tooMany("Ekspor dibatasi 3x per jam. Tunggu sebentar ya.");
    }
    const idx = await readIndex(uid);
    const conversations: Conversation[] = [];
    for (const item of idx) {
      const file = await readJson<Conversation>(convPath(uid, item.conversation_id));
      if (file) {
        const { geminiSessionId: _gsid, ...safe } = file.data as Conversation & { geminiSessionId?: unknown };
        safe.messages = (Array.isArray(safe.messages) ? safe.messages : [])
          .filter((m) => m && typeof m === "object") as Message[];
        conversations.push(safe);
      }
    }
    return json({ user_id: uid, exported_at: nowIso(), conversations });
  }

  const id = String(searchParams.get("id") || "");
  if (id) {
    if (!/^[a-f0-9-]{8,36}$/.test(id)) {
      return json({ error: "ID tidak valid" }, 400);
    }
    const file = await readJson<Conversation>(convPath(uid, id));
    if (!file) return json({ error: "Percakapan tidak ditemukan" }, 404);
    // Jangan bocorkan session_id Gemini ke klien
    if (!allowUser("convs-read", uid, req, 120, 60_000)) {
      return tooMany();
    }
    const { geminiSessionId: _gsid, ...safe } = file.data as Conversation & { geminiSessionId?: unknown };
    // Defensif: pesan harus array of object
    safe.messages = (Array.isArray(safe.messages) ? safe.messages : [])
      .filter((m) => m && typeof m === "object") as Message[];
    return json({ conversation: safe });
  }

  // ---------------- Daftar (paginated) ----------------
  // Anti-scraping: ukuran halaman DIBATASI server (maks 50) —
  // ?limit=999999 diabaikan. Offset divalidasi sebagai integer.
  if (!allowUser("convs-list", uid, req, 120, 60_000)) {
    return tooMany();
  }
  const limit = Math.min(Math.max(parseInt(searchParams.get("limit") || "50", 10) || 50, 1), 50);
  const offset = Math.max(parseInt(searchParams.get("offset") || "0", 10) || 0, 0);
  const all = await readIndex(uid);
  const items = all.slice(offset, offset + limit);
  return json({ items, total: all.length, has_more: offset + items.length < all.length });
}

export async function POST(req: Request) {
  const session = await getSession(req.headers);
  if (!session) return json({ error: "Belum login", code: "SESSION_INVALID" }, 401);

  if (session) {
    const maintGate = await maintenanceBlockResponse();
    if (maintGate) return maintGate;
  }
  const uid = session.user_id;

  if (!originOk(req)) return forbidden();
  if (!allowUser("convs-write", uid, req, 40, 60_000)) {
    return tooMany();
  }

  const body = await readBody(req);

  // ---------------- action=recover: pulihkan riwayat ----------------
  if (body.action === "recover") {
    const paths = await listJsonPaths(`chats/${uid}`);
    const ids = paths
      .map((p) => (p.split("/").pop() || "").replace(/\.json$/, ""))
      .filter((name) => name !== "_index" && /^[a-f0-9-]{8,36}$/.test(name))
      .slice(0, 150);

    const items: ConversationItem[] = [];
    for (const id of ids) {
      const file = await readJson<Conversation>(convPath(uid, id));
      const c = file?.data;
      if (c && typeof c === "object" && Array.isArray(c.messages)) {
        items.push({
          conversation_id: id,
          title: typeof c.title === "string" && c.title ? c.title : "Chat baru",
          updated_at: c.updated_at || c.created_at || "",
        });
      }
    }
    items.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));

    // Tulis ulang index SECARA PENUH (bukan updateJson)
    await putJson(idxPath(uid), items, "conversation index recover");
    return json({ ok: true, recovered: items.length });
  }

  // ---------------- percakapan baru ----------------
  const conv: Conversation & { geminiSessionId?: string | null } = {
    conversation_id: crypto.randomUUID(),
    user_id: uid,
    title: "Chat baru",
    created_at: nowIso(),
    updated_at: nowIso(),
    geminiSessionId: null,
    messages: [],
  };
  // 2 file berbeda (percakapan & index) tidak saling bergantung → paralel
  await Promise.all([
    putJson(convPath(uid, conv.conversation_id), conv, "conversation create"),
    updateJson<ConversationItem[]>(idxPath(uid), "conversation index", (current) => {
      const items = Array.isArray(current) ? current : [];
      items.push({
        conversation_id: conv.conversation_id,
        title: conv.title,
        updated_at: conv.updated_at,
      });
      return items;
    }),
  ]);
  return json(
    { conversation_id: conv.conversation_id, title: conv.title },
    201
  );
}

export async function DELETE(req: Request) {
  const session = await getSession(req.headers);
  if (!session) return json({ error: "Belum login", code: "SESSION_INVALID" }, 401);

  if (session) {
    const maintGate = await maintenanceBlockResponse();
    if (maintGate) return maintGate;
  }
  const uid = session.user_id;

  if (!originOk(req)) return forbidden();
  if (!allowUser("convs-del", uid, req, 60, 60_000)) {
    return tooMany();
  }

  const { searchParams } = new URL(req.url);

  // ?all=1 → hapus SEMUA percakapan user. Jalur khusus Settings > Data;
  // konfirmasi dua-langkah ada di UI, server tetap butuh session valid.
  // Destruktif → jauh lebih ketat dari delete biasa.
  if (searchParams.get("all") === "1") {
    if (!allowUser("convs-wipe", uid, req, 6, 60 * 60_000)) {
      return tooMany("Hapus massal dibatasi 6x per jam. Tunggu sebentar ya.");
    }
    const idx = await readIndex(uid);
    for (const item of idx) {
      await deleteJson(convPath(uid, item.conversation_id));
    }
    await putJson(idxPath(uid), [], "conversation wipe");
    return json({ ok: true, deleted: idx.length });
  }

  const id = String(searchParams.get("id") || "");
  if (!/^[a-f0-9-]{8,36}$/.test(id)) {
    return json({ error: "ID tidak valid" }, 400);
  }

  // DELETE ?id=conv&message_id=xxx → hapus SATU pesan (history konsisten)
  const mid = String(searchParams.get("message_id") || "");
  if (mid) {
    if (!/^[a-f0-9-]{8,36}$/.test(mid)) {
      return json({ error: "ID tidak valid" }, 400);
    }
    const file = await readJson<Conversation>(convPath(uid, id));
    if (!file) return json({ error: "Percakapan tidak ditemukan" }, 404);
    const msgs = Array.isArray(file.data.messages) ? file.data.messages : [];
    const idx = msgs.findIndex((m) => m && m.message_id === mid);
    if (idx < 0) return json({ error: "Pesan tidak ditemukan" }, 404);
    msgs.splice(idx, 1);
    file.data.messages = msgs;
    file.data.updated_at = nowIso();
    await putJson(convPath(uid, id), file.data, "message delete");
    await updateJson<ConversationItem[]>(idxPath(uid), "conversation index", (current) => {
      const items = Array.isArray(current) ? current : [];
      const i = items.findIndex((c) => c.conversation_id === id);
      if (i >= 0) items[i] = { ...items[i], updated_at: file.data.updated_at };
      return items;
    });
    return json({ ok: true });
  }

  const file = await readJson(convPath(uid, id));
  if (file) await deleteJson(convPath(uid, id));
  // Bersihkan entri index SELALU (termasuk entri "hantu" tanpa file).
  await updateJson<ConversationItem[]>(idxPath(uid), "conversation index", (current) => {
    const items = Array.isArray(current) ? current : [];
    return items.filter((c) => c.conversation_id !== id);
  });
  return json({ ok: true });
}

export async function PUT() {
  return methodNotAllowed("GET, POST, DELETE");
}
