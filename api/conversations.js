// ============================================================
// /api/conversations — riwayat percakapan per user (wajib login)
//
// GET            → daftar ringkas percakapan user (indeks, ringan)
// GET ?id=xxx    → isi satu percakapan
// POST           → buat percakapan baru
// DELETE ?id=xxx → hapus percakapan
//
// Path repo: chats/<userId>/<chatId>.json + chats/<userId>/_index.json
// ============================================================

import crypto from 'node:crypto';
import { readJson, putJson, updateJson, deleteJson, listJsonPaths } from '../lib/store.js';
import { getSession } from '../lib/auth.js';

const convPath = (uid, id) => `chats/${uid}/${id}.json`;
const idxPath = (uid) => `chats/${uid}/_index.json`;

const nowIso = () => new Date().toISOString();

function indexEntry(conv) {
  return {
    conversation_id: conv.conversation_id,
    title: conv.title,
    updated_at: conv.updated_at
  };
}

async function readIndex(userId) {
  const file = await readJson(idxPath(userId));
  const items = Array.isArray(file?.data) ? file.data : [];
  return items.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const session = await getSession(req);
  if (!session) return res.status(401).json({ error: 'Belum login' , code: 'SESSION_INVALID' });
  const uid = session.user_id;

  // ---------------- GET: daftar atau satu percakapan ----------------
  if (req.method === 'GET') {
    const id = String(req.query?.id || '');
    if (id) {
      if (!/^[a-f0-9-]{8,36}$/.test(id)) {
        return res.status(400).json({ error: 'ID tidak valid' });
      }
      const file = await readJson(convPath(uid, id));
      if (!file) return res.status(404).json({ error: 'Percakapan tidak ditemukan' });
      // Jangan bocorkan session_id Gemini ke klien
      const { geminiSessionId, ...safe } = file.data;
      // Defensif: pesan harus array of object — data lama/rusak tidak
      // boleh membuat route 500 (dan memicu penghapusan riwayat di klien)
      safe.messages = (Array.isArray(safe.messages) ? safe.messages : [])
        .filter((m) => m && typeof m === 'object');
      return res.status(200).json({ conversation: safe });
    }
    return res.status(200).json({ items: await readIndex(uid) });
  }

  // ---------------- POST action=recover: pulihkan riwayat ----------------
  // _index.json bisa hilang (mis. terhapus karena error sesaat di klien).
  // File percakapannya MASIH ADA di penyimpanan — bangun ulang index darinya.
  if (req.method === 'POST' && req.body?.action === 'recover') {
    const paths = await listJsonPaths(`chats/${uid}`);
    const ids = paths
      .map((p) => p.split('/').pop().replace(/\.json$/, ''))
      .filter((name) => name !== '_index' && /^[a-f0-9-]{8,36}$/.test(name))
      .slice(0, 150);

    const items = [];
    for (const id of ids) {
      const file = await readJson(convPath(uid, id));
      const c = file?.data;
      if (c && typeof c === 'object' && Array.isArray(c.messages)) {
        items.push({
          conversation_id: id,
          title: typeof c.title === 'string' && c.title ? c.title : 'Chat baru',
          updated_at: c.updated_at || c.created_at || ''
        });
      }
    }
    items.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));

    // Tulis ulang index SECARA PENUH (bukan updateJson) — hasil pemulihan
    await putJson(idxPath(uid), items, 'conversation index recover');
    return res.status(200).json({ ok: true, recovered: items.length });
  }

  // ---------------- POST: percakapan baru ----------------
  if (req.method === 'POST') {
    const conv = {
      conversation_id: crypto.randomUUID(),
      user_id: uid,
      title: 'Chat baru',
      created_at: nowIso(),
      updated_at: nowIso(),
      geminiSessionId: null,
      messages: []
    };
    await putJson(convPath(uid, conv.conversation_id), conv, 'conversation create');
    await updateJson(idxPath(uid), 'conversation index', (current) => {
      const items = Array.isArray(current) ? current : [];
      items.push(indexEntry(conv));
      return items;
    });
    return res.status(201).json({
      conversation_id: conv.conversation_id,
      title: conv.title
    });
  }

  // ---------------- DELETE: hapus percakapan / satu pesan ----------------
  if (req.method === 'DELETE') {
    const id = String(req.query?.id || '');
    if (!/^[a-f0-9-]{8,36}$/.test(id)) {
      return res.status(400).json({ error: 'ID tidak valid' });
    }

    // DELETE ?id=conv&message_id=xxx → hapus SATU pesan (history konsisten)
    const mid = String(req.query?.message_id || '');
    if (mid) {
      if (!/^[a-f0-9-]{8,36}$/.test(mid)) {
        return res.status(400).json({ error: 'ID tidak valid' });
      }
      const file = await readJson(convPath(uid, id));
      if (!file) return res.status(404).json({ error: 'Percakapan tidak ditemukan' });
      const msgs = Array.isArray(file.data.messages) ? file.data.messages : [];
      const idx = msgs.findIndex((m) => m && m.message_id === mid);
      if (idx < 0) return res.status(404).json({ error: 'Pesan tidak ditemukan' });
      msgs.splice(idx, 1);
      file.data.messages = msgs;
      file.data.updated_at = nowIso();
      await putJson(convPath(uid, id), file.data, 'message delete');
      await updateJson(idxPath(uid), 'conversation index', (current) => {
        const items = Array.isArray(current) ? current : [];
        const i = items.findIndex((c) => c.conversation_id === id);
        if (i >= 0) items[i] = { ...items[i], updated_at: file.data.updated_at };
        return items;
      });
      return res.status(200).json({ ok: true });
    }

    const file = await readJson(convPath(uid, id));
    if (file) await deleteJson(convPath(uid, id));
    // Bersihkan entri index SELALU, bukan hanya kalau file ketemu — kalau
    // tidak, entri "hantu" (ada di daftar riwayat, tapi file-nya sudah
    // tidak ada — mis. peninggalan migrasi/outage lama) tidak akan pernah
    // bisa dihapus karena baris di atas butuh file ada dulu.
    await updateJson(idxPath(uid), 'conversation index', (current) => {
      const items = Array.isArray(current) ? current : [];
      return items.filter((c) => c.conversation_id !== id);
    });
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ error: 'Method tidak diizinkan' });
}
