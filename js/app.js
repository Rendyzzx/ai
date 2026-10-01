/* ============================================================
   Aomi — app.js
   Titik masuk aplikasi: utilitas bersama, penyimpanan, dan
   event bus antar modul. Tidak menyentuh DOM chat/sidebar
   langsung (itu tugas modul masing-masing).
   ============================================================ */

// ---------------- Utilitas kecil ----------------

export const $ = (sel, root = document) => root.querySelector(sel);

/** Debounce untuk event berfrekuensi tinggi (search, resize, dst). */
export const debounce = (fn, ms = 150) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

/** Wrapper requestAnimationFrame: gabung banyak panggilan jadi 1 frame. */
export const raf = (fn) => {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn();
    });
  };
};

// ---------------- Event bus antar modul (hemat listener) ----------------

const bus = new EventTarget();

export const emit = (name, detail) =>
  bus.dispatchEvent(new CustomEvent(name, { detail }));

export const on = (name, handler) =>
  bus.addEventListener(name, handler);

// ---------------- Penyimpanan ----------------
// Indeks riwayat dipisah dari isi chat supaya membuka aplikasi
// tidak pernah memuat seluruh histori sekaligus.

const INDEX_KEY = 'aomi.index.v1';
const CURRENT_KEY = 'aomi.current.v1';
const chatKey = (id) => `aomi.chat.${id}`;

const safeParse = (raw) => {
  try { return JSON.parse(raw); } catch { return null; }
};

export const Store = {
  /** Daftar ringkas: [{ id, title, snippet, updatedAt, count }] */
  readIndex() {
    const list = safeParse(localStorage.getItem(INDEX_KEY));
    return Array.isArray(list) ? list : [];
  },

  writeIndex(list) {
    localStorage.setItem(INDEX_KEY, JSON.stringify(list));
  },

  readChat(id) {
    return safeParse(localStorage.getItem(chatKey(id)));
  },

  writeChat(chat) {
    // Hanya pesan terbaru yang disimpan; riwayat sangat panjang dipangkas.
    if (chat.messages.length > STORE_CAP) {
      chat.messages = chat.messages.slice(-STORE_CAP);
    }
    try {
      localStorage.setItem(chatKey(chat.id), JSON.stringify(chat));
    } catch {
      // localStorage penuh → buang chat terlama lalu coba lagi
      const index = this.readIndex();
      if (index.length > 1) {
        this.deleteChat(index[index.length - 1].id);
        localStorage.setItem(chatKey(chat.id), JSON.stringify(chat));
      }
    }
  },

  deleteChat(id) {
    localStorage.removeItem(chatKey(id));
    const index = this.readIndex().filter((c) => c.id !== id);
    this.writeIndex(index);
  },

  upsertIndexEntry(entry) {
    const index = this.readIndex().filter((c) => c.id !== entry.id);
    index.push(entry);
    // Terbaru selalu di atas → pencarian & render murah
    index.sort((a, b) => b.updatedAt - a.updatedAt);
    this.writeIndex(index);
  },

  readCurrentId() {
    return localStorage.getItem(CURRENT_KEY);
  },

  writeCurrentId(id) {
    if (id) localStorage.setItem(CURRENT_KEY, id);
    else localStorage.removeItem(CURRENT_KEY);
  },
};

const STORE_CAP = 200; // pesan maksimum per chat yang disimpan

// ---------------- Sanitasi input pengguna ----------------

/** Buang karakter kontrol & batasi panjang (anti XSS by construction). */
export const sanitizeText = (text, maxLen = 4000) =>
  String(text)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, maxLen)
    .trim();

// ---------------- Bootstrap ----------------

import { initSidebar } from './sidebar.js';
import { initChat } from './chat.js';

const boot = () => {
  initSidebar();
  initChat();
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
