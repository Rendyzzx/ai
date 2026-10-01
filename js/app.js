/* ============================================================
   Aomi — app.js
   Titik masuk aplikasi: utilitas bersama, event bus antar modul,
   gerbang otentikasi. Penyimpanan chat sepenuhnya di server
   (per akun) — tidak ada localStorage untuk riwayat.
   ============================================================ */

// ---------------- Utilitas kecil ----------------

export const $ = (sel, root = document) => root.querySelector(sel);

export const debounce = (fn, ms = 150) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

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

/** Buang karakter kontrol & batasi panjang. */
export const sanitizeText = (text, maxLen = 4000) =>
  String(text)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, maxLen)
    .trim();

// ---------------- Event bus antar modul ----------------

const bus = new EventTarget();

export const emit = (name, detail) =>
  bus.dispatchEvent(new CustomEvent(name, { detail }));

export const on = (name, handler) =>
  bus.addEventListener(name, handler);

// ---------------- Helper API (redirect bila sesi habis) ----------------

export async function api(path, options = {}) {
  const res = await fetch(path, options);
  if (res.status === 401) {
    location.replace('/auth.html');
    throw new Error('unauthorized');
  }
  return res;
}

export async function apiJson(path, options = {}) {
  const res = await api(path, options);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || 'Gagal memuat data');
  return data;
}

// ---------------- Gerbang auth + bootstrap ----------------

import { initSidebar } from './sidebar.js';
import { initChat } from './chat.js';

async function boot() {
  let me = null;
  try {
    me = await apiJson('/api/auth/me');
  } catch (err) {
    if (err.message === 'unauthorized') return; // sudah redirect
    // Server tak terjangkau → tampilkan error sederhana
    document.body.textContent = 'Tidak bisa menghubungi server. Muat ulang halaman.';
    return;
  }

  const user = me.user;

  // Info user + logout di sidebar
  $('#userBox').textContent = user.username;

  initSidebar();
  initChat(user);

  $('#logoutBtn').addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      /* lanjut redirect meskipun gagal */
    }
    location.replace('/auth.html');
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
