/* ============================================================
   Aomi — settings.js
   Modal pengaturan: tab Profil & Bot. Upload avatar dengan
   kompresi klien (canvas 256px JPEG) → preview → simpan via
   backend (yang memvalidasi ulang). Perubahan diterapkan lokal
   tanpa reload halaman.
   ============================================================ */

import { $, renderAvatar, api, apiJson, state, emit, raf } from './app.js';

const els = {};
let pending = { userAvatar: null, botAvatar: null }; // preview belum disimpan
let activeTab = 'profile';

const MAX_INPUT_BYTES = 5 * 1024 * 1024; // 5 MB mentah dari perangkat
const AVATAR_SIZE = 256;                  // ukuran simpan (square, cover)

export function initSettings() {
  els.modal = $('#settingsModal');
  els.profileForm = $('#profileForm');
  els.botForm = $('#botForm');

  bindChrome();
  fillForms();
}

/* ---------------- Buka/tutup & tab ---------------- */

function bindChrome() {
  $('#settingsBtn').addEventListener('click', open);
  $('#settingsClose').addEventListener('click', close);
  els.modal.addEventListener('click', (e) => {
    if (e.target === els.modal) close();          // klik backdrop → tutup
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.modal.hidden) close();
  });

  // Delegasi tab
  document.querySelector('.settings-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.settings-tab');
    if (tab) showTab(tab.dataset.tab);
  });

  // Upload avatar (user & bot)
  $('#profileAvatarBtn').addEventListener('click', () => $('#profileAvatarFile').click());
  $('#botAvatarBtn').addEventListener('click', () => $('#botAvatarFile').click());
  $('#profileAvatarFile').addEventListener('change', (e) => onAvatarPick(e, 'user'));
  $('#botAvatarFile').addEventListener('change', (e) => onAvatarPick(e, 'bot'));

  els.profileForm.addEventListener('submit', saveProfile);
  els.botForm.addEventListener('submit', saveBot);

  $('#logoutBtn').addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch { /* lanjut redirect */ }
    location.replace('/auth.html');
  });
}

function open() {
  fillForms();
  els.modal.hidden = false;
}

function close() {
  els.modal.hidden = true;
  pending.userAvatar = null;
  pending.botAvatar = null;
}

function showTab(name) {
  activeTab = name;
  for (const btn of document.querySelectorAll('.settings-tab')) {
    btn.classList.toggle('active', btn.dataset.tab === name);
  }
  els.profileForm.hidden = name !== 'profile';
  els.botForm.hidden = name !== 'bot';
}

function fillForms() {
  $('#profileUsername').value = state.user.username;
  $('#profileDisplay').value = state.user.display_name;
  $('#profileBio').value = state.user.bio;
  renderAvatar($('#profileAvatarPrev'), state.user.avatar, 'user');

  $('#botName').value = state.bot.bot_name;
  $('#botPersonality').value = state.bot.personality;
  $('#botPrompt').value = state.bot.system_prompt;
  $('#botLanguage').value = state.bot.language;
  $('#botStyle').value = state.bot.response_style;
  renderAvatar($('#botAvatarPrev'), state.bot.bot_avatar, 'logo');

  $('#profileError').textContent = '';
  $('#botError').textContent = '';
}

/* ---------------- Pilih & kompres avatar ---------------- */

async function onAvatarPick(e, kind) {
  const file = e.target.files?.[0];
  e.target.value = '';                      // agar file sama bisa dipilih ulang
  if (!file) return;

  const errEl = kind === 'user' ? $('#profileError') : $('#botError');
  errEl.textContent = '';

  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    errEl.textContent = 'Format harus JPG, PNG, atau WebP.';
    return;
  }
  if (file.size > MAX_INPUT_BYTES) {
    errEl.textContent = 'File terlalu besar (maks 5 MB).';
    return;
  }

  try {
    const dataUrl = await compressToAvatar(file);
    pending[kind === 'user' ? 'userAvatar' : 'botAvatar'] = dataUrl;
    renderAvatar(
      kind === 'user' ? $('#profileAvatarPrev') : $('#botAvatarPrev'),
      dataUrl, kind === 'user' ? 'user' : 'logo'
    );
  } catch {
    errEl.textContent = 'Gagal memproses gambar. Coba file lain.';
  }
}

/** Kompres ke avatar persegi 256px (crop cover tengah) → JPEG. */
function compressToAvatar(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode gagal')); };
    img.onload = () => {
      // raf: pastikan revoke tidak sebelum decode selesai
      requestAnimationFrame(() => URL.revokeObjectURL(url));

      const canvas = document.createElement('canvas');
      canvas.width = AVATAR_SIZE;
      canvas.height = AVATAR_SIZE;
      const ctx = canvas.getContext('2d');

      // crop persegi di tengah (cover), bukan stretch
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const sx = (img.naturalWidth - side) / 2;
      const sy = (img.naturalHeight - side) / 2;
      ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);

      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.src = url;
  });
}

/* ---------------- Simpan profil ---------------- */

async function saveProfile(e) {
  e.preventDefault();
  const btn = $('#profileSave');
  const errEl = $('#profileError');
  errEl.textContent = '';
  btn.disabled = true;

  const body = {
    username: $('#profileUsername').value.trim(),
    display_name: $('#profileDisplay').value.trim(),
    bio: $('#profileBio').value.trim()
  };
  if (pending.userAvatar !== null) body.avatar = pending.userAvatar;

  try {
    const profile = await apiJson('/api/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    Object.assign(state.user, profile);
    pending.userAvatar = null;

    // terapkan lokal, tanpa reload
    $('#userBox').textContent = profile.display_name;
    renderAvatar($('#sidebarAvatar'), profile.avatar, 'user');
    emit('settings:updated');
    close();
  } catch (err) {
    if (err.message === 'unauthorized') return;
    errEl.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- Simpan bot ---------------- */

async function saveBot(e) {
  e.preventDefault();
  const btn = $('#botSave');
  const errEl = $('#botError');
  errEl.textContent = '';
  btn.disabled = true;

  const body = {
    bot_name: $('#botName').value.trim(),
    personality: $('#botPersonality').value.trim(),
    system_prompt: $('#botPrompt').value.trim(),
    language: $('#botLanguage').value,
    response_style: $('#botStyle').value
  };
  if (pending.botAvatar !== null) body.bot_avatar = pending.botAvatar;

  try {
    const data = await apiJson('/api/bot', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    Object.assign(state.bot, data.bot);
    pending.botAvatar = null;

    // terapkan lokal: brand, header, welcome, label pesan
    $('#brandName').textContent = data.bot.bot_name;
    const title = $('#chatTitle');
    if (title.dataset.default === '1' || !title.textContent) {
      title.textContent = data.bot.bot_name;
    }
    emit('settings:updated');
    close();
  } catch (err) {
    if (err.message === 'unauthorized') return;
    errEl.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

// ekspor kecil untuk chat.js (label who saat typing)
export const botName = () => state.bot.bot_name;
