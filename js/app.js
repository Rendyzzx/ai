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
 *
 * Anti-"jeda kelihatan": gambar di-decode PENUH dulu di luar DOM
 * (img.decode()), BARU ikon lama dihapus & foto dipasang — satu
 * swap atomic, tanpa frame kosong di antaranya. Tanpa ini: ikon
 * lama hilang duluan (el.textContent='') sementara <img> yang baru
 * dipasang belum selesai decode → ada jeda kosong sampai browser
 * selesai decode byte-nya.
 * Juga skip total (tanpa kerja/flash apa pun) bila avatar yang
 * diminta SAMA PERSIS dengan yang sudah tampil — updateCharHead()
 * dipanggil berkali-kali (tiap kirim pesan dsb.), bukan hanya saat
 * avatar benar-benar berubah.
 */
export function renderAvatar(el, dataUrl, fallbackIcon) {
  if (!dataUrl) {
    el.textContent = '';
    delete el.dataset.avatarSrc;
    el.innerHTML =
      `<svg class="icon" aria-hidden="true"><use href="components/icons.svg#${fallbackIcon}" /></svg>`;
    return;
  }
  if (el.dataset.avatarSrc === dataUrl) return;   // sudah tampil persis ini

  const img = new Image();
  img.alt = '';
  img.decoding = 'async';
  img.src = dataUrl;

  const swap = () => {
    el.textContent = '';
    el.appendChild(img);
    el.dataset.avatarSrc = dataUrl;
  };

  if (img.decode) {
    img.decode().then(swap).catch(swap);   // format aneh/gagal decode → tetap tampilkan
  } else if (img.complete) {
    swap();
  } else {
    img.onload = swap;
    img.onerror = swap;
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

// ---------------- Debug logging (development) ----------------
// Aktif HANYA dengan ?debug=1 di URL atau localStorage 'aomi.debug'='1'.
// Mati total di production → aman ditinggal. Tidak pernah log password,
// token, atau session id penuh (hanya 8 karakter pertama sebagai penanda).

const DEBUG = (() => {
  try {
    return new URLSearchParams(location.search).get('debug') === '1'
      || localStorage.getItem('aomi.debug') === '1';
  } catch { return false; }
})();

export function dbg(tag, msg) {
  if (DEBUG) console.log(`[${tag}]`, msg);
}

// ---------------- Event bus antar modul ----------------

const bus = new EventTarget();

export const emit = (name, detail) =>
  bus.dispatchEvent(new CustomEvent(name, { detail }));

export const on = (name, handler) =>
  bus.addEventListener(name, (e) => handler(e.detail));

// ---------------- State global (profil + bot user login) ----------------
// SATU sumber kebenaran di client — semua component membaca dari sini.

export const state = {
  user: { username: '', display_name: '', bio: '', avatar: null, email: '' },
  bot: {
    bot_name: 'Aomi', bot_avatar: null, personality: '',
    traits: ['playful', 'caring'], speaking_style: 'casual',
    relationship: 'companion', greeting: '', likes: '', avoids: '',
    memories: [],
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
  dbg('AUTH', 'session invalid → teardown + redirect chat → login');
  Object.assign(state.user, { username: '', display_name: '', bio: '', avatar: null, email: '' });
  Object.assign(state.bot, {
    bot_name: 'Aomi', bot_avatar: null, personality: '',
    traits: ['playful', 'caring'], speaking_style: 'casual',
    relationship: 'companion', greeting: '', likes: '', avoids: '',
    memories: [],
    system_prompt: '', language: 'auto', response_length: 'balanced',
    response_style: 'casual', personality_preset: 'friendly',
    bot_description: ''
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

// ---------------- Dialog konfirmasi kustom ----------------
// Pengganti window.confirm() bawaan browser (yang nongol sebagai
// popup "situs menyatakan…") — pakai markup #confirmOverlay di index.html.
let confirmResolve = null;

export function confirmDialog(message, okLabel = 'Hapus', cancelLabel = 'Batal') {
  const overlay = document.getElementById('confirmOverlay');
  const msgEl = document.getElementById('confirmMsg');
  if (!overlay || !msgEl) return Promise.resolve(window.confirm(message)); // jaga-jaga

  msgEl.textContent = message;
  document.getElementById('confirmOk').textContent = okLabel;
  document.getElementById('confirmCancel').textContent = cancelLabel;
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add('show'));

  return new Promise((resolve) => {
    confirmResolve = (result) => {
      overlay.classList.remove('show');
      setTimeout(() => { overlay.hidden = true; }, 150);
      confirmResolve = null;
      resolve(result);
    };
  });
}

function bindConfirmDialog() {
  const overlay = document.getElementById('confirmOverlay');
  if (!overlay) return;
  document.getElementById('confirmOk')?.addEventListener('click', () => confirmResolve?.(true));
  document.getElementById('confirmCancel')?.addEventListener('click', () => confirmResolve?.(false));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) confirmResolve?.(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) confirmResolve?.(false);
  });
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

import { initSidebar } from './sidebar.js?v=1764d59c65';
import { initChat } from './chat.js?v=1764d59c65';

// Settings dimuat LAZY: baru di-import saat pertama kali dibuka
let settingsMod = null;
async function openSettings(category) {
  if (!settingsMod) settingsMod = await import('./settings.js?v=1764d59c65');
  settingsMod.openSettings(category);
}

function showBootError() {
  // Jangan hapus seluruh <body> (membuat halaman terasa beku) —
  // pesan ringkas + tombol coba lagi, tetap bisa disentuh.
  const font = getComputedStyle(document.documentElement).fontFamily || 'sans-serif';
  document.body.innerHTML = `
    <div style="min-height:100dvh;display:grid;place-items:center;padding:24px;text-align:center;font-family:${font}">
      <div>
        <p style="margin-bottom:14px;color:#a3a099;font-size:14px;">Tidak bisa menghubungi server. Periksa koneksimu.</p>
        <button id="retryBoot" style="padding:10px 20px;border-radius:10px;background:#d29763;color:#1d150d;border:0;font-size:14px;cursor:pointer;">Coba lagi</button>
      </div>
    </div>`;
  document.getElementById('retryBoot').addEventListener('click', () => location.reload());
}

async function boot() {
  // Auth init IDEMPOTENT: hanya sekali per page load, apapun yang
  // memicunya (DOMContentLoaded, retry, dsb.) — tidak pernah dobel.
  if (window.APP_INITIALIZED) return;
  window.APP_INITIALIZED = true;

  dbg('ROUTER', 'route: / (chatbox) — boot mulai');
  bindViewport();
  bindConfirmDialog();

  // STEP 0 — tanpa session identifier → langsung login (UI tidak dirender).
  // Redirect ini TIDAK bisa memantul balik: auth.html tanpa sid tidak
  // pernah me-redirect kembali (precheck hanya jalan bila ada sid).
  if (!getSessionId()) {
    location.replace('/auth.html');
    return;
  }

  // STEP 0.5 — tampilkan avatar dari cache lokal SEGERA, SEBELUM fetch
  // apa pun selesai. Elemen avatar sudah ada di HTML statis (ikon
  // default) — di sini kita langsung ganti ke foto asli dari cache
  // tanpa menunggu /api/auth/me → /api/profile → /api/bot (2 round-trip
  // berurutan). Ini yang menghilangkan 'jeda' sebelum foto muncul untuk
  // user yang kembali. Kalau datanya nanti berubah di server, STEP 4
  // akan menimpa — tapi kalau SAMA, renderAvatar skip (tanpa flash).
  try {
    const cachedBot = localStorage.getItem('aomi.cache.botAvatar');
    const cachedUser = localStorage.getItem('aomi.cache.userAvatar');
    if (cachedBot) {
      renderAvatar($('#charAvatar'), cachedBot, 'logo');
      renderAvatar($('#welcomeAvatar'), cachedBot, 'logo');
    }
    if (cachedUser) renderAvatar($('#sidebarAvatar'), cachedUser, 'user');
  } catch { /* private mode / storage diblokir */ }

  // STEP 1-3 — validasi session: SERVER satu-satunya sumber kebenaran.
  // /api/auth/me menolak (401) bila sid salah, session expired, atau
  // APP_VERSION beda (deployment baru → session dihancurkan server,
  // client di-teardown oleh handleAuthInvalid). Versi TIDAK dicek di
  // client — pengecekan versi lokal hanya menambah jalur redirect
  // tanpa menghapus sid, dan itu penyebab bounce '/' <-> '/auth.html'.
  let me;
  try {
    const sid0 = getSessionId();
    dbg('SESSION', 'validating session id=' + (sid0 ? sid0.slice(0, 8) + '…' : 'none'));
    const meRes = await api('/api/auth/me');
    me = await meRes.json();
    dbg('SESSION', 'valid — server menerima session');
    dbg('VERSION', 'server app_version=' + (me.app_version || '(kosong)'));
    // simpan versi hanya untuk info/diagnostik — TIDAK untuk navigasi
    try { localStorage.setItem('aomi.appVersion', me.app_version || ''); } catch { /* pv */ }
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

    // Simpan avatar terbaru ke cache lokal untuk load SELANJUTNYA
    // (lihat STEP 0.5 di atas) — bukan untuk render saat ini.
    try {
      if (state.bot.bot_avatar) localStorage.setItem('aomi.cache.botAvatar', state.bot.bot_avatar);
      else localStorage.removeItem('aomi.cache.botAvatar');
      if (state.user.avatar) localStorage.setItem('aomi.cache.userAvatar', state.user.avatar);
      else localStorage.removeItem('aomi.cache.userAvatar');
    } catch { /* private mode / quota */ }
  } catch (err) {
    if (err.message === 'unauthorized') return;
    showBootError();
    return;
  }

  // STEP 5 — state siap → render Chat UI
  $('#userBox').textContent = state.user.display_name || state.user.username;
  renderAvatar($('#sidebarAvatar'), state.user.avatar, 'user');
  $('#brandName').textContent = state.bot.bot_name;
  // Header chat = identitas karakter (nama), bukan judul percakapan
  $('#chatTitle').textContent = state.bot.bot_name;

  // Tampilan: ukuran font tersimpan lokal (tanpa fetch)
  try {
    const fs = localStorage.getItem('aomi.fontSize');
    if (fs) document.documentElement.style.setProperty('--chat-fs', fs + 'px');
  } catch { /* private mode */ }

  initSidebar();
  initChat();
  dbg('AUTH', 'boot selesai → TETAP di chatbox (tidak ada redirect)');

  $('#settingsBtn').addEventListener('click', () => openSettings());
  // kartu karakter di sidebar → buka pengaturan karakter
  on('settings:openCharacter', () => openSettings('bot'));

  // PRELOAD settings saat idle — buka settings PERTAMA jadi instan.
  // Tanpa ini: dynamic import ±250ms (+ jaringan di HP) tepat saat
  // tombol pertama kali diklik → terasa freeze. Specifier HARUS sama
  // persis dengan openSettings() supaya instance modulnya satu.
  const preload = window.requestIdleCallback
    ? (cb) => window.requestIdleCallback(cb, { timeout: 2000 })
    : (cb) => setTimeout(cb, 600);
  preload(() => { import('./settings.js?v=1764d59c65').catch(() => {}); });

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
