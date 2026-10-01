/* ============================================================
   Aomi — app.js
   Titik masuk aplikasi: utilitas bersama, event bus, state
   (profil user + konfigurasi bot), gerbang auth, sinkronisasi
   tinggi viewport (visualViewport) untuk keyboard mobile.
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

/**
 * Render avatar ke container: <img> bila ada dataUrl,
 * kalau tidak → ikon SVG default (bukan emoji).
 */
export function renderAvatar(el, dataUrl, fallbackIcon) {
  el.textContent = '';
  if (dataUrl) {
    const img = new Image();
    img.alt = '';
    img.decoding = 'async';
    img.src = dataUrl;
    el.appendChild(img);
  } else {
    el.innerHTML =
      `<svg class="icon" aria-hidden="true"><use href="components/icons.svg#${fallbackIcon}" /></svg>`;
  }
}

/** Bersihkan seluruh state/cache klien milik aplikasi (prefiks aomi.*). */
export function resetClientState() {
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('aomi.')) localStorage.removeItem(k);
    }
  } catch { /* private mode */ }
}

// ---------------- Event bus antar modul ----------------

const bus = new EventTarget();

export const emit = (name, detail) =>
  bus.dispatchEvent(new CustomEvent(name, { detail }));

export const on = (name, handler) =>
  bus.addEventListener(name, handler);

// ---------------- State global (profil + bot user login) ----------------

export const state = {
  user: { username: '', display_name: '', bio: '', avatar: null },
  bot: {
    bot_name: 'Aomi', bot_avatar: null, personality: '',
    system_prompt: '', language: 'id', response_style: 'casual'
  }
};

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

// ---------------- Tinggi viewport & keyboard mobile ----------------
// Satu listener visualViewport (bukan polling): set --app-h agar
// seluruh app pas di area terlihat; komposer otomatis duduk tepat
// di atas keyboard. Diabaikan saat pinch-zoom (scale ≠ 1).

const syncViewport = raf(() => {
  const vv = window.visualViewport;
  if (!vv || vv.scale !== 1) return;
  document.documentElement.style.setProperty('--app-h', Math.round(vv.height) + 'px');
});

function bindViewport() {
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncViewport);
  }
  syncViewport();
}

// ---------------- Gerbang auth + bootstrap ----------------

import { initSidebar } from './sidebar.js';
import { initChat } from './chat.js';

// Settings dimuat LAZY: baru di-import saat pertama kali dibuka
// (UI chat tetap ringan, tanpa chunk kecil berlebihan)
let settingsMod = null;
async function openSettings() {
  if (!settingsMod) settingsMod = await import('./settings.js');
  settingsMod.openSettings();
}

async function boot() {
  bindViewport();

  let me = null;
  try {
    // me + profil + bot diambil paralel (hemat waktu boot)
    const [meRes, profileRes, botRes] = await Promise.all([
      api('/api/auth/me'),
      api('/api/profile'),
      api('/api/bot')
    ]);
    me = await meRes.json();
    const profile = await profileRes.json();
    const botCfg = await botRes.json();

    // ---------- Deployment check (tanpa polling) ----------
    // Session versi lama sudah dihancurkan server (401). Jika cookie
    // ternyata masih valid tapi versi klien berbeda dari server,
    // bersihkan seluruh state klien lama → jangan pakai UI lama.
    const serverVersion = me.app_version;
    const storedVersion = (() => {
      try { return localStorage.getItem('aomi.appVersion'); } catch { return null; }
    })();
    if (storedVersion && serverVersion && storedVersion !== serverVersion) {
      resetClientState();
      try { localStorage.setItem('aomi.appVersion', serverVersion); } catch { /* pv */ }
      location.replace('/auth.html');
      return;
    }
    if (!storedVersion && serverVersion) {
      try { localStorage.setItem('aomi.appVersion', serverVersion); } catch { /* pv */ }
    }

    Object.assign(state.user, profile);
    Object.assign(state.bot, botCfg.bot);
  } catch (err) {
    if (err.message === 'unauthorized') return; // sudah redirect
    document.body.textContent = 'Tidak bisa menghubungi server. Muat ulang halaman.';
    return;
  }

  // Info user + nama bot di UI
  $('#userBox').textContent = state.user.display_name || state.user.username;
  renderAvatar($('#sidebarAvatar'), state.user.avatar, 'user');
  $('#brandName').textContent = state.bot.bot_name;
  $('#chatTitle').textContent = state.bot.bot_name;
  $('#chatTitle').dataset.default = '1';

  // Tampilan: ukuran font tersimpan lokal (tanpa fetch)
  try {
    const fs = localStorage.getItem('aomi.fontSize');
    if (fs) document.documentElement.style.setProperty('--chat-fs', fs + 'px');
  } catch { /* private mode */ }

  initSidebar();
  initChat();

  $('#settingsBtn').addEventListener('click', openSettings);
  watchSession();
}

// Validasi sesi ringan saat tab kembali aktif (visibilitychange,
// dibatasi 1x/menit — bukan setInterval, tidak membebani CPU/RAM).
let lastSessionCheck = Date.now();
function watchSession() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastSessionCheck < 60_000) return;
    lastSessionCheck = Date.now();
    fetch('/api/auth/me').then((r) => {
      if (r.status === 401) location.replace('/auth.html');
    }).catch(() => { /* offline: abaikan */ });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
