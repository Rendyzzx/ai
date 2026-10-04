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
import type { BookmarkEntry, Conversation, ConversationItem, Message } from "@/types";
import { getFlags } from "@/lib/server/features";

export const dynamic = "force-dynamic";

const convPath = (uid: string, id: string) => `chats/${uid}/${id}.json`;
const idxPath = (uid: string) => `chats/${uid}/_index.json`;
const bookmarksPath = (uid: string) => `chats/${uid}/_bookmarks.json`;

const nowIso = () => new Date().toISOString();

const BOOKMARKS_CAP = 200;
const BOOKMARK_CONTENT_MAX = 8_000;
const SEARCH_CONV_SCAN = 40;      // maks file percakapan yang dibaca per query
const SEARCH_SNIPPET = 110;       // panjang potongan teks di hasil pencarian

const validId = (id: string) => /^[a-f0-9-]{8,36}$/.test(id);

async function readBookmarks(uid: string): Promise<BookmarkEntry[]> {
  const file = await readJson<BookmarkEntry[]>(bookmarksPath(uid));
  return Array.isArray(file?.data) ? file.data : [];
}

/** Cari "window" snippet ± SEARCH_SNIPPET/2 di sekitar kecocokan pertama. */
function snippetAround(content: string, q: string): string | null {
  const lower = content.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx < 0) return null;
  const half = Math.floor(SEARCH_SNIPPET / 2);
  const from = Math.max(0, idx - half);
  const to = Math.min(content.length, idx + q.length + half);
  const raw = content.slice(from, to).replace(/\s+/g, " ").trim();
  return (from > 0 ? "…" : "") + raw + (to < content.length ? "…" : "");
}

async function readIndex(uid: string): Promise<ConversationItem[]> {
  const file = await readJson<ConversationItem[]>(idxPath(uid));
  const items = Array.isArray(file?.data) ? file.data : [];
  // Pinned selalu di atas (urutan dalam grup tetap by updated_at)
  return items.sort((a, b) => {
    const pa = a.pinned ? 1 : 0;
    const pb = b.pinned ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return (b.updated_at || "").localeCompare(a.updated_at || "");
  });
}

/** Upsert entri index percakapan (dipakai semua jalur tulis pesan). */
async function touchIndex(uid: string, entry: ConversationItem): Promise<void> {
  await updateJson<ConversationItem[]>(idxPath(uid), "conversation index", (current) => {
    const items = Array.isArray(current) ? current : [];
    const i = items.findIndex((c) => c.conversation_id === entry.conversation_id);
    // Merge, bukan replace — pin/archive harus selamat lewat update judul/waktu.
    if (i >= 0) items[i] = { ...items[i], ...entry };
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

  // ?bookmarks=1 → daftar "Simpanan" (bookmark jawaban Aomi)
  if (searchParams.get("bookmarks") === "1") {
    const flags = await getFlags();
    if (!flags.bookmark) {
      return json({ error: "Fitur Simpanan sedang dinonaktifkan sementara oleh admin." }, 503);
    }
    if (!allowUser("bm-list", uid, req, 60, 60_000)) return tooMany();
    const items = await readBookmarks(uid);
    return json({ items });
  }

  // ?q= → cari judul + isi percakapan (server-side, cap scan)
  const q = String(searchParams.get("q") || "").trim().toLowerCase();
  if (q) {
    const flags = await getFlags();
    if (!flags.search) {
      return json({ error: "Pencarian sedang dinonaktifkan sementara oleh admin." }, 503);
    }
    if (q.length < 2 || q.length > 80) {
      return json({ items: [], total: 0, has_more: false });
    }
    if (!allowUser("convs-search", uid, req, 30, 60_000)) return tooMany();
    const all = await readIndex(uid);
    const out: (ConversationItem & { snippet?: string })[] = [];
    // Tahap 1: judul (murah, selalu)
    for (const it of all) {
      if ((it.title || "").toLowerCase().includes(q)) out.push(it);
    }
    // Tahap 2: isi percakapan (q >= 3 karakter, cap SEARCH_CONV_SCAN file,
    // skip yang sudah match di judul biar tidak dobel baca file)
    if (q.length >= 3) {
      let scanned = 0;
      for (const it of all) {
        if (scanned >= SEARCH_CONV_SCAN) break;
        if (out.some((o) => o.conversation_id === it.conversation_id)) continue;
        const file = await readJson<Conversation>(convPath(uid, it.conversation_id));
        scanned++;
        if (!file) continue;
        const msgs = Array.isArray(file.data.messages) ? file.data.messages : [];
        for (const m of msgs) {
          if (!m || typeof m.content !== "string" || !m.content) continue;
          const sn = snippetAround(m.content, q);
          if (sn) {
            out.push({ ...it, snippet: sn });
            break;
          }
        }
      }
    }
    return json({ items: out, total: out.length, has_more: false });
  }

  const id = String(searchParams.get("id") || "");
  if (id) {
    if (!validId(id)) {
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
      .filter((name) => !name.startsWith("_") && /^[a-f0-9-]{8,36}$/.test(name))
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
    // Pertahankan pin/archive dari index lama (recover = perbaiki, bukan reset)
    const oldIdx = await readIndex(uid);
    const oldById = new Map(oldIdx.map((c) => [c.conversation_id, c]));
    for (const it of items) {
      const old = oldById.get(it.conversation_id);
      if (old?.pinned) it.pinned = true;
      if (old?.archived) it.archived = true;
    }
    items.sort((a, b) => {
      const pa = a.pinned ? 1 : 0;
      const pb = b.pinned ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return (b.updated_at || "").localeCompare(a.updated_at || "");
    });

    // Tulis ulang index SECARA PENUH (bukan updateJson)
    await putJson(idxPath(uid), items, "conversation index recover");
    return json({ ok: true, recovered: items.length });
  }

  // ---------------- action=pin / archive ----------------
  // Field di entri index existing (migration-safe: lama = undefined/false).
  if (body.action === "pin" || body.action === "archive") {
    const flags = await getFlags();
    if (!flags.pin) {
      return json({ error: "Fitur pin sedang dinonaktifkan sementara oleh admin." }, 503);
    }
    const cid = String(body.conversation_id || "");
    if (!validId(cid)) return json({ error: "ID tidak valid" }, 400);
    const value = Boolean(body.value);
    const field = body.action === "pin" ? "pinned" : "archived";
    await updateJson<ConversationItem[]>(idxPath(uid), "conversation index", (current) => {
      const items = Array.isArray(current) ? current : [];
      const i = items.findIndex((c) => c.conversation_id === cid);
      if (i >= 0) {
        items[i] = { ...items[i], [field]: value };
        if (!value && items[i][field] === false) delete items[i][field];
      }
      return items;
    });
    return json({ ok: true, [field]: value });
  }

  // ---------------- action=bookmark: simpan jawaban Aomi ke "Simpanan" ----------------
  if (body.action === "bookmark" || body.action === "unbookmark") {
    const flags = await getFlags();
    if (!flags.bookmark) {
      return json({ error: "Fitur Simpanan sedang dinonaktifkan sementara oleh admin." }, 503);
    }
    const cid = String(body.conversation_id || "");
    const mid = String(body.message_id || "");
    if (!validId(cid) || !validId(mid)) return json({ error: "ID tidak valid" }, 400);

    const file = await readJson<Conversation>(convPath(uid, cid));
    if (!file) return json({ error: "Percakapan tidak ditemukan" }, 404);
    const conv = file.data;
    const msg = (Array.isArray(conv.messages) ? conv.messages : []).find(
      (m) => m && m.message_id === mid && m.role === "assistant"
    );
    if (!msg) return json({ error: "Pesan tidak ditemukan" }, 404);

    if (body.action === "bookmark") {
      const entry: BookmarkEntry = {
        message_id: mid,
        conversation_id: cid,
        conversation_title: conv.title || "Chat baru",
        content: String(msg.content || "").slice(0, BOOKMARK_CONTENT_MAX),
        saved_at: nowIso(),
      };
      let existed = false;
      await updateJson<BookmarkEntry[]>(bookmarksPath(uid), "bookmarks", (current) => {
        const items = Array.isArray(current) ? current : [];
        existed = items.some((b) => b && b.message_id === mid);
        if (!existed) items.unshift(entry);
        return items.slice(0, BOOKMARKS_CAP);
      });
      if (!existed) {
        msg.bookmarked = true;
        await putJson(convPath(uid, cid), conv, "message bookmark");
      }
      return json({ ok: true, bookmarked: true });
    }

    // unbookmark: buang dari daftar + bersihkan flag di pesan
    await updateJson<BookmarkEntry[]>(bookmarksPath(uid), "bookmarks", (current) => {
      const items = Array.isArray(current) ? current : [];
      return items.filter((b) => !(b && b.message_id === mid));
    });
    if (msg.bookmarked) {
      msg.bookmarked = undefined;
      await putJson(convPath(uid, cid), conv, "message unbookmark");
    }
    return json({ ok: true, bookmarked: false });
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

  // ?bookmark_id= → hapus SATU entri Simpanan (snapshot tetap ada walau
  // percakapan sumbernya sudah dihapus → best-effort bersihkan flag).
  const bid = String(searchParams.get("bookmark_id") || "");
  if (bid) {
    const flags = await getFlags();
    if (!flags.bookmark) {
      return json({ error: "Fitur Simpanan sedang dinonaktifkan sementara oleh admin." }, 503);
    }
    await updateJson<BookmarkEntry[]>(bookmarksPath(uid), "bookmarks", (current) => {
      const items = Array.isArray(current) ? current : [];
      return items.filter((b) => !(b && b.message_id === bid));
    });
    // Best-effort: kalau percakapan sumber masih ada, bersihkan flag di pesan.
    // Klien modern mengirim conversation_id → hanya 1 file dibaca (bukan scan).
    const srcCid = String(searchParams.get("conversation_id") || "");
    if (srcCid && validId(srcCid)) {
      const cf = await readJson<Conversation>(convPath(uid, srcCid)).catch(() => null);
      const conv = cf?.data;
      const m = conv
        ? (Array.isArray(conv.messages) ? conv.messages : []).find(
            (x) => x && x.message_id === bid && x.bookmarked
          )
        : null;
      if (m) {
        m.bookmarked = undefined;
        await putJson(convPath(uid, srcCid), conv, "bookmark remove").catch(() => {});
      }
    }
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
