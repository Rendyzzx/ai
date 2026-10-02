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
import { readJson, putJson, updateJson, deleteJson } from '../lib/store.js';
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
      return res.status(200).json({ conversation: safe });
    }
    return res.status(200).json({ items: await readIndex(uid) });
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

  // ---------------- DELETE: hapus percakapan ----------------
  if (req.method === 'DELETE') {
    const id = String(req.query?.id || '');
    if (!/^[a-f0-9-]{8,36}$/.test(id)) {
      return res.status(400).json({ error: 'ID tidak valid' });
    }
    const file = await readJson(convPath(uid, id));
    if (file) {
      await deleteJson(convPath(uid, id));
      await updateJson(idxPath(uid), 'conversation index', (current) => {
        const items = Array.isArray(current) ? current : [];
        return items.filter((c) => c.conversation_id !== id);
      });
    }
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ error: 'Method tidak diizinkan' });
}
