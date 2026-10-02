/* ============================================================
   Aomi — app.js
   Titik masuk aplikasi: utilitas bersama, event bus, state
   (profil user + konfigurasi bot), gerbang auth bertahap,
   sinkronisasi tinggi viewport (visualViewport) untuk keyboard.
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

// ---------------- Session id (OPAQUE, sessionStorage only) ----------------
// Tidak ada credential/password/token/API key di browser — hanya
// session identifier acak yang divalidasi server di SETIAP request.
// sessionStorage: mati saat tab ditutup → tidak ada auth persisten.

const SID_KEY = 'aomi.sid';

export function getSessionId() {
  try { return sessionStorage.getItem(SID_KEY); } catch { return null; }
}

export function setSessionId(sid) {
  try { sessionStorage.setItem(SID_KEY, sid); } catch { /* private */ }
}

export function clearSessionId() {
  try { sessionStorage.removeItem(SID_KEY); } catch { /* private */ }
}

// ---------------- Event bus antar modul ----------------

const bus = new EventTarget();

export const emit = (name, detail) =>
  bus.dispatchEvent(new CustomEvent(name, { detail }));

export const on = (name, handler) =>
  bus.addEventListener(name, handler);

// ---------------- State global (profil + bot user login) ----------------
// SATU sumber kebenaran di client — semua component membaca dari sini.

export const state = {
  user: { username: '', display_name: '', bio: '', avatar: null, email: '' },
  bot: {
    bot_name: 'Aomi', bot_avatar: null, personality: '',
    system_prompt: '', language: 'auto', response_length: 'balanced',
    response_style: 'casual', personality_preset: 'friendly',
    bot_description: ''
  }
};

/**
 * Teardown total saat server menolak session (SESSION_INVALID /
 * APP_VERSION_MISMATCH / expired): bersihkan SELURUH state aplikasi —
 * user, profile, personality bot, chat, cache — lalu ke halaman login.
 * Guard: beberapa fetch paralel yang sama-sama 401 hanya memicu sekali.
 */
let tearingDown = false;
export function handleAuthInvalid() {
  if (tearingDown) return;
  tearingDown = true;
  Object.assign(state.user, { username: '', display_name: '', bio: '', avatar: null, email: '' });
  Object.assign(state.bot, {
    bot_name: 'Aomi', bot_avatar: null, personality: '', system_prompt: '',
    language: 'auto', response_length: 'balanced', response_style: 'casual',
    personality_preset: 'friendly', bot_description: ''
  });
  clearSessionId();
  resetClientState();
  location.replace('/auth.html');
}

// ---------------- Helper API (session via header) ----------------
// Setiap request menyertakan X-Session-Id; server memvalidasi session.
// 401 → teardown state + login (tidak pernah pakai UI/state lama).

export async function api(path, options = {}) {
  const sid = getSessionId();
  const headers = new Headers(options.headers || {});
  if (sid) headers.set('X-Session-Id', sid);
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) {
    handleAuthInvalid();
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
let settingsMod = null;
async function openSettings() {
  if (!settingsMod) settingsMod = await import('./settings.js');
  settingsMod.openSettings();
}

function showBootError() {
  // Jangan hapus seluruh <body> (membuat halaman terasa beku) —
  // pesan ringkas + tombol coba lagi, tetap bisa disentuh.
  const font = getComputedStyle(document.documentElement).fontFamily || 'sans-serif';
  document.body.innerHTML = `
    <div style="min-height:100dvh;display:grid;place-items:center;padding:24px;text-align:center;font-family:${font}">
      <div>
        <p style="margin-bottom:14px;color:#9b9ba4;font-size:14px;">Tidak bisa menghubungi server. Periksa koneksimu.</p>
        <button id="retryBoot" style="padding:10px 20px;border-radius:10px;background:#6f7dff;color:#fff;border:0;font-size:14px;cursor:pointer;">Coba lagi</button>
      </div>
    </div>`;
  document.getElementById('retryBoot').addEventListener('click', () => location.reload());
}

async function boot() {
  bindViewport();

  // STEP 0 — tanpa session identifier → langsung login (UI tidak dirender)
  if (!getSessionId()) {
    location.replace('/auth.html');
    return;
  }

  // STEP 1-3 — validasi versi + session: server sumber kebenaran.
  // /api/auth/me menolak (401) bila sid salah, session expired, atau
  // APP_VERSION berbeda (deployment baru → semua user logout).
  let me;
  try {
    const meRes = await api('/api/auth/me');
    me = await meRes.json();

    // STEP 2 — versi klien vs server: clear stale state, ke login
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
  } catch (err) {
    if (err.message === 'unauthorized') return; // teardown + login berjalan
    showBootError();
    return;
  }

  // STEP 4 — session valid → baru muat data user (profil + personality)
  try {
    const [profileRes, botRes] = await Promise.all([
      api('/api/profile'),
      api('/api/bot')
    ]);
    const profile = await profileRes.json();
    const botCfg = await botRes.json();
    Object.assign(state.user, profile);
    Object.assign(state.bot, botCfg.bot);
  } catch (err) {
    if (err.message === 'unauthorized') return;
    showBootError();
    return;
  }

  // STEP 5 — state siap → render Chat UI
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
// dibatasi 1x/menit — bukan setInterval).
let lastSessionCheck = Date.now();
function watchSession() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastSessionCheck < 60_000) return;
    lastSessionCheck = Date.now();
    fetch('/api/auth/me', { headers: { 'X-Session-Id': getSessionId() || '' } })
      .then((r) => {
        if (r.status === 401) handleAuthInvalid();
      })
      .catch(() => { /* offline: abaikan */ });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
